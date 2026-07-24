import { timingSafeEqual } from 'node:crypto'
import { type Context, Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { cors } from 'hono/cors'
import type { JwtVariables } from 'hono/jwt'
import { jwt } from 'hono/jwt'
import { openAPIRouteHandler } from 'hono-openapi'
import { createErrorResponse } from './api-helpers'
import {
	AuditEntryNotFoundError,
	AuthorizationError,
	PgHistoryError,
	RevertError,
	SearchConcurrencyLimitError,
	SetupRequiredError,
	TableNotConfiguredError,
	ValidationError,
} from './errors'
import { consoleLogger, type Logger } from './logger'
import { Orchestrator } from './orchestrator'
import { PgHistory } from './PgHistory'
import { validateIdentifier } from './pg-history-validators'
import { getArchivalStats, setupArchiverSchema } from './schema'
import type { ServerConfig } from './types'
import { parseRevertBody, parseSearchBody } from './validation'

type Variables = JwtVariables & {
	pgHistory?: PgHistory
}

export async function createServer(config: ServerConfig): Promise<{
	app: Hono<{ Variables: Variables }>
	dispose: (drainTimeoutMs?: number) => Promise<void>
}> {
	const app = new Hono<{ Variables: Variables }>()
	const logger: Logger = config.logger ?? consoleLogger

	// Resolve JWT secret once. Trim to catch accidental empty-string values that
	// would otherwise silently disable auth while `jwtSecret` is falsy.
	const jwtSecret = process.env.PG_HISTORY_JWT_SECRET?.trim() || undefined

	// FAIL CLOSED (C2): the history read API and the destructive
	// POST /api/history/revert endpoint have no authentication unless a JWT
	// secret is configured. Refuse to start rather than silently exposing them.
	// `allowUnauthenticated: true` is the explicit opt-in for local dev / trusted
	// private networks.
	if (
		config.enableHistory &&
		!jwtSecret &&
		config.allowUnauthenticated !== true
	) {
		throw new Error(
			'Refusing to start: enableHistory is set but PG_HISTORY_JWT_SECRET is not configured. ' +
				'The history read API and the destructive POST /api/history/revert endpoint would be ' +
				'exposed without authentication. Set PG_HISTORY_JWT_SECRET, or pass ' +
				'allowUnauthenticated: true to explicitly opt in (local development / trusted network only).',
		)
	}

	// Instance-scoped state — not module-level globals, so multiple createServer()
	// calls (tests, hot reload) each get their own isolated state.
	let currentArchivalPromise: Promise<void> | null = null
	let archivalInterval: ReturnType<typeof setInterval> | undefined
	let rateLimitCleanupInterval: ReturnType<typeof setInterval> | undefined
	let archivalRetryTimer: ReturnType<typeof setTimeout> | undefined
	let archivalRetryResolve: (() => void) | undefined
	let disposed = false
	let inFlightRequests = 0
	const inFlightWaiters: Array<() => void> = []

	function waitForInFlightRequests(timeoutMs: number): Promise<void> {
		if (inFlightRequests === 0) return Promise.resolve()
		return new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				const idx = inFlightWaiters.indexOf(resolve)
				if (idx >= 0) inFlightWaiters.splice(idx, 1)
				resolve()
			}, timeoutMs)
			inFlightWaiters.push(() => {
				clearTimeout(timer)
				resolve()
			})
		})
	}

	// CORS — applied before any other middleware so preflight OPTIONS gets
	// proper headers without hitting auth or body-limit checks.
	if (config.cors) {
		app.use('*', cors(config.cors))
	}

	// Limit request body size to 1MB to prevent memory exhaustion
	app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024 }))

	// Track in-flight requests so graceful shutdown can drain
	app.use('*', async (_c, next) => {
		inFlightRequests++
		try {
			await next()
		} finally {
			inFlightRequests--
			if (inFlightRequests === 0) {
				for (const waiter of inFlightWaiters.splice(0)) waiter()
			}
		}
	})

	// In-memory rate limiter — only useful in long-running processes, skip in serverless.
	// SERVERLESS DEPLOYMENTS (e.g. Vercel) get NO application-layer rate limiting and
	// MUST configure gateway/edge rate limiting. The mode-independent DoS backstop is
	// the search-concurrency limit in PgHistory (maxConcurrentSearches).
	// x-forwarded-for / x-real-ip are client-spoofable, so per-IP buckets are only
	// meaningful behind a trusted proxy that overwrites them — gated on config.trustProxy.
	// When trustProxy is false (default) we fall back to a single GLOBAL bucket: a coarse
	// but unspoofable flood backstop, since a per-request-spoofed header would otherwise
	// hand every request a fresh bucket and defeat the limiter entirely.
	if (!config.serverless) {
		const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
		const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
		const RATE_LIMIT_MAX = 100 // per-IP requests per window (trustProxy mode)
		// Global-bucket ceiling when we can't trust client identity. Higher than the
		// per-IP cap because it is shared across ALL clients.
		const RATE_LIMIT_MAX_GLOBAL = 1_000
		const RATE_LIMIT_CLEANUP_INTERVAL_MS = 30_000 // sweep every 30s
		// Cap map size to prevent memory exhaustion from a flood of unique IPs
		// arriving between sweeps. When the cap is hit we evict the oldest
		// inserted entry (Map preserves insertion order). This is a coarse LRU —
		// safe under attack because the bound on memory is fixed.
		const RATE_LIMIT_MAX_ENTRIES = 10_000

		// Periodically sweep expired entries on a timer instead of in the
		// request path. Bounded at ~2x MAX entries in the worst case until the
		// next sweep.
		rateLimitCleanupInterval = setInterval(() => {
			const cleanupNow = Date.now()
			for (const [key, val] of rateLimitMap) {
				if (cleanupNow > val.resetAt) rateLimitMap.delete(key)
			}
		}, RATE_LIMIT_CLEANUP_INTERVAL_MS)
		// Don't hold the event loop open just for cleanup
		if (
			typeof rateLimitCleanupInterval === 'object' &&
			rateLimitCleanupInterval &&
			'unref' in rateLimitCleanupInterval
		) {
			;(rateLimitCleanupInterval as unknown as { unref: () => void }).unref()
		}

		app.use('/api/*', async (c, next) => {
			// Only trust client-supplied IP headers behind a trusted proxy;
			// otherwise use one global bucket that cannot be spoofed away.
			const key = config.trustProxy
				? c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
					c.req.header('x-real-ip') ||
					'unknown'
				: 'global'
			const maxForKey = config.trustProxy
				? RATE_LIMIT_MAX
				: RATE_LIMIT_MAX_GLOBAL

			const now = Date.now()
			const entry = rateLimitMap.get(key)

			if (!entry || now > entry.resetAt) {
				if (rateLimitMap.size >= RATE_LIMIT_MAX_ENTRIES) {
					const oldest = rateLimitMap.keys().next().value
					if (oldest !== undefined) rateLimitMap.delete(oldest)
				}
				rateLimitMap.set(key, {
					count: 1,
					resetAt: now + RATE_LIMIT_WINDOW_MS,
				})
			} else {
				entry.count++
				if (entry.count > maxForKey) {
					return c.json(
						createErrorResponse(
							'RATE_LIMITED',
							'Too many requests. Try again later.',
						),
						429,
					)
				}
			}

			await next()
		})
	}

	// Initialize PgHistory if enabled
	let pgHistory: PgHistory | undefined
	if (config.enableHistory && config.historyConfig) {
		logger.info('Initializing PgHistory API')
		pgHistory = new PgHistory({
			tables: config.historyConfig.tables,
			pool: config.pool,
			logger,
		})
		await pgHistory.setup()
		// After PgHistory setup, also run archiver schema setup below so the
		// soft_deleted_at column exists. Invalidate the cached column check.
		if (config.enableArchiver) {
			pgHistory.invalidateSoftDeleteColumnCache()
		}
	}

	// Store in context for route handlers
	app.use('*', async (c, next) => {
		if (pgHistory) {
			c.set('pgHistory', pgHistory)
		}
		await next()
	})

	// Archival health state — exposed via /health endpoint
	const archivalHealth: {
		status: 'idle' | 'running' | 'completed' | 'failed'
		lastError: string | null
		attempts: number
		lastCompletedAt: Date | null
	} = {
		status: 'idle',
		lastError: null,
		attempts: 0,
		lastCompletedAt: null,
	}

	// Archival runner — shared by background scheduler and on-demand endpoint
	let runArchival: () => Promise<void> = () => Promise.resolve()

	if (config.enableArchiver && config.archiverConfig) {
		// Validate retry config BEFORE schema setup so misconfiguration surfaces
		// before any DB work is done — easier to debug than a DDL error.
		const MAX_ATTEMPTS = config.archivalRetry?.maxAttempts ?? 4
		const RETRY_DELAYS = config.archivalRetry?.delays ?? [5_000, 15_000, 60_000]
		if (MAX_ATTEMPTS < 1) {
			throw new Error('archivalRetry.maxAttempts must be >= 1')
		}
		if (RETRY_DELAYS.length < MAX_ATTEMPTS - 1) {
			throw new Error(
				`archivalRetry.delays must have at least maxAttempts - 1 (${MAX_ATTEMPTS - 1}) entries`,
			)
		}

		logger.info('Setting up archiver schema')
		await setupArchiverSchema(config.pool)
		// If PgHistory is also enabled, the soft-delete column now exists
		if (pgHistory) pgHistory.invalidateSoftDeleteColumnCache()

		const archiverConfig = config.archiverConfig
		const runOptions = config.runOptions || {}
		let archivalRunning = false

		runArchival = async (): Promise<void> => {
			if (archivalRunning) return // prevent overlapping runs
			archivalRunning = true

			try {
				for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
					try {
						archivalHealth.status = 'running'
						archivalHealth.attempts++

						const orchestrator = new Orchestrator({
							s3: archiverConfig.s3,
							retention: archiverConfig.retention,
							gracePeriod: archiverConfig.gracePeriod,
							batchSize: archiverConfig.batchSize ?? 10_000,
							logger,
						})

						const stats = await orchestrator.run(config.pool, runOptions)

						logger.info('Archival complete', {
							tables: stats.tables.length,
							recordsArchived: stats.totalRecordsArchived,
							recordsSoftDeleted: stats.totalRecordsSoftDeleted,
							recordsHardDeleted: stats.totalRecordsHardDeleted,
							errors: stats.errors.length,
							durationMs: stats.durationMs,
						})

						for (const error of stats.errors) {
							logger.error('Table processing error', { err: error })
						}

						// orchestrator.run() NEVER rejects for per-table failures — it
						// collects them in stats.errors and resolves. Treat a run where
						// every table failed as a hard failure so the retry/backoff loop
						// engages and /health reports 'degraded' instead of 'ok'.
						const processErrors = stats.errors.filter(
							(e) => e.operation === 'process_table',
						)
						const failedTables = new Set(processErrors.map((e) => e.table))
						if (
							stats.tables.length > 0 &&
							failedTables.size >= stats.tables.length
						) {
							throw new Error(
								`Archival failed for all ${stats.tables.length} table(s): ${processErrors
									.map((e) => `${e.table}: ${e.error}`)
									.join('; ')}`,
							)
						}

						archivalHealth.status = 'completed'
						// Surface partial failures in /api/health/detailed rather than
						// masking them behind a clean 'completed'.
						archivalHealth.lastError =
							processErrors.length > 0
								? `Partial failure: ${processErrors.length} of ${stats.tables.length} table(s) failed`
								: null
						archivalHealth.lastCompletedAt = new Date()
						// Reset attempts so this counter represents "retries since
						// last success", not "lifetime archival count" — operators
						// reading /api/health/detailed expect the former.
						archivalHealth.attempts = 0
						return
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err)
						archivalHealth.status = 'failed'
						archivalHealth.lastError = message

						if (attempt < MAX_ATTEMPTS - 1 && !disposed) {
							const baseDelay = RETRY_DELAYS[attempt] ?? 60_000
							// 0..25% jitter so multiple instances retrying after a
							// common failure (DB blip, S3 outage) don't all wake at
							// once and rebuild the dogpile that caused the failure.
							const jitter = Math.floor(Math.random() * baseDelay * 0.25)
							const delay = baseDelay + jitter
							logger.error('Background archival failed, retrying', {
								attempt: attempt + 1,
								maxAttempts: MAX_ATTEMPTS,
								delayMs: delay,
								message,
							})
							// Sleep with a handle that dispose() can cancel so SIGTERM
							// during a long retry backoff doesn't block process exit.
							// unref() prevents the timer from holding the event loop
							// alive past process intent.
							await new Promise<void>((resolve) => {
								archivalRetryResolve = resolve
								archivalRetryTimer = setTimeout(() => {
									archivalRetryTimer = undefined
									archivalRetryResolve = undefined
									resolve()
								}, delay)
								if (
									typeof archivalRetryTimer === 'object' &&
									archivalRetryTimer &&
									'unref' in archivalRetryTimer
								) {
									;(
										archivalRetryTimer as unknown as { unref: () => void }
									).unref()
								}
							})
							if (disposed) return
						} else {
							logger.error('Background archival failed after all attempts', {
								attempts: MAX_ATTEMPTS,
								message,
							})
						}
					}
				}
			} finally {
				archivalRunning = false
			}
		}

		// In long-running mode: run immediately + schedule periodic runs
		if (!config.serverless) {
			const trackAndRun = (): Promise<void> => {
				const p = runArchival()
				currentArchivalPromise = p
				p.finally(() => {
					if (currentArchivalPromise === p) currentArchivalPromise = null
				})
				return p
			}

			logger.info('Running archival process in background')
			trackAndRun()

			const MIN_INTERVAL_MS = 60_000 // 1 minute minimum to prevent tight loops
			const intervalMs = Math.max(
				MIN_INTERVAL_MS,
				Number.parseInt(
					process.env.PG_HISTORY_ARCHIVAL_INTERVAL_MS || '3600000',
					10,
				) || 3_600_000,
			)
			archivalInterval = setInterval(() => {
				logger.info('Running scheduled archival')
				trackAndRun().catch((err) => {
					logger.error('Scheduled archival failed', { err })
				})
			}, intervalMs)
			// Don't hold the event loop open just for archival scheduling.
			// Without unref(), a process crash before dispose() leaves the event
			// loop alive indefinitely.
			if (
				typeof archivalInterval === 'object' &&
				archivalInterval &&
				'unref' in archivalInterval
			) {
				;(archivalInterval as unknown as { unref: () => void }).unref()
			}
		}
	}

	// Conditionally apply JWT auth if PG_HISTORY_JWT_SECRET is set (resolved once
	// at the top of createServer). When set, we also gate the /openapi endpoint
	// by default unless the consumer explicitly opts into publicOpenApi.
	if (jwtSecret) {
		// hono/jwt's supported algorithms. Default HS256 for backwards compat;
		// allow asymmetric algs (RS256/ES256) for Vercel/Cloudflare deployments
		// that sign with a private key and distribute the public key.
		const SUPPORTED_ALGS = [
			'HS256',
			'HS384',
			'HS512',
			'RS256',
			'RS384',
			'RS512',
			'ES256',
			'ES384',
			'ES512',
		] as const
		type JwtAlg = (typeof SUPPORTED_ALGS)[number]
		const requestedAlg =
			process.env.PG_HISTORY_JWT_ALG?.trim().toUpperCase() || 'HS256'
		if (!(SUPPORTED_ALGS as readonly string[]).includes(requestedAlg)) {
			throw new Error(
				`PG_HISTORY_JWT_ALG="${requestedAlg}" not supported. Allowed: ${SUPPORTED_ALGS.join(', ')}`,
			)
		}
		const alg = requestedAlg as JwtAlg
		logger.info('JWT authentication enabled', { alg })
		const jwtMiddleware = jwt({ secret: jwtSecret, alg })
		// Skip JWT for CORS preflight — browsers send OPTIONS without auth.
		// Without this, preflight returns 401 and the browser blocks the
		// real request.
		const jwtSkipOptions = (
			c: Parameters<typeof jwtMiddleware>[0],
			next: Parameters<typeof jwtMiddleware>[1],
		) => (c.req.method === 'OPTIONS' ? next() : jwtMiddleware(c, next))
		app.use('/api/*', jwtSkipOptions)
		if (!config.publicOpenApi) {
			app.use('/openapi', jwtSkipOptions)
		}
	} else if (config.enableHistory) {
		logger.warn(
			'API endpoints are unauthenticated. Set PG_HISTORY_JWT_SECRET for production use.',
		)
	}

	// Security headers for all responses
	app.use('*', async (c, next) => {
		await next()
		c.header('X-Content-Type-Options', 'nosniff')
		c.header('X-Frame-Options', 'DENY')
	})

	// Resolve cron secret once. Used by /api/archive, /api/stats, and
	// /api/health/detailed so none are exposed unauthenticated in cron-only
	// deployments (where jwtSecret is unset and the global /api/* JWT
	// middleware therefore wasn't registered).
	const cronSecret = config.enableArchiver
		? (config.archiveCronSecret || process.env.CRON_SECRET)?.trim() || undefined
		: undefined

	// Fail closed: the archiver stats / detailed-health endpoints leak table
	// names, row volumes, and failure state. Only register them when SOME auth
	// exists (JWT or cron secret) or the operator explicitly opted out. Without
	// this, a deployment with neither secret served them anonymously.
	const archiverEndpointsAuthorized =
		!!jwtSecret || !!cronSecret || config.allowUnauthenticated === true
	if (config.enableArchiver && !archiverEndpointsAuthorized) {
		logger.warn(
			'/api/stats and /api/health/detailed NOT registered: no authentication configured. ' +
				'Set PG_HISTORY_JWT_SECRET or archiveCronSecret / CRON_SECRET, or pass allowUnauthenticated: true.',
		)
	}

	async function verifyCronSecret(authHeader: string): Promise<boolean> {
		if (!cronSecret) return true // not configured — JWT path is authoritative
		const { createHmac } = await import('node:crypto')
		const expected = `Bearer ${cronSecret}`
		const key = Buffer.from(cronSecret)
		const mac = (v: string) => createHmac('sha256', key).update(v).digest()
		return timingSafeEqual(mac(authHeader), mac(expected))
	}

	// Public health endpoint — minimal surface. Returns only status to avoid
	// leaking operational posture (last archival time, failure counts) to
	// unauthenticated callers. Probes DB connectivity with a bounded SELECT 1 so
	// the platform health check (fly.toml) fails over instead of routing traffic
	// to an instance whose every /api/* request 500s.
	app.get('/health', async (c) => {
		let timer: ReturnType<typeof setTimeout> | undefined
		try {
			await Promise.race([
				config.pool.query('SELECT 1'),
				new Promise((_, reject) => {
					timer = setTimeout(
						() => reject(new Error('health check DB probe timed out')),
						2_000,
					)
				}),
			])
		} catch (err) {
			logger.error('health check DB probe failed', { err })
			return c.json({ status: 'error' }, 503)
		} finally {
			if (timer) clearTimeout(timer)
		}
		const status =
			config.enableArchiver && archivalHealth.status === 'failed'
				? 'degraded'
				: 'ok'
		return c.json({ status })
	})

	// Detailed health endpoint — auth-gated via /api/* JWT middleware (when set)
	// or cron secret. Exposes archival attempts and last completion time.
	if (config.enableArchiver && archiverEndpointsAuthorized) {
		app.get('/api/health/detailed', async (c) => {
			if (!jwtSecret && cronSecret) {
				const ok = await verifyCronSecret(c.req.header('authorization') ?? '')
				if (!ok) {
					return c.json(
						createErrorResponse('UNAUTHORIZED', 'Invalid cron secret'),
						401,
					)
				}
			}
			return c.json({
				status: archivalHealth.status === 'failed' ? 'degraded' : 'ok',
				archival: {
					status: archivalHealth.status,
					attempts: archivalHealth.attempts,
					lastCompletedAt: archivalHealth.lastCompletedAt,
					lastError: archivalHealth.lastError,
				},
			})
		})
	}

	// Archival stats endpoint. Auth contract: JWT middleware (when configured)
	// already authenticated /api/* before reaching here. When only cron secret
	// is configured, JWT middleware was not registered and we must verify the
	// HMAC inline — otherwise this endpoint would be public.
	if (config.enableArchiver && archiverEndpointsAuthorized) {
		app.get('/api/stats', async (c) => {
			if (!jwtSecret && cronSecret) {
				const ok = await verifyCronSecret(c.req.header('authorization') ?? '')
				if (!ok) {
					return c.json(
						createErrorResponse('UNAUTHORIZED', 'Invalid cron secret'),
						401,
					)
				}
			}
			try {
				const stats = await getArchivalStats(config.pool)
				return c.json({ stats })
			} catch (error) {
				logger.error('getArchivalStats error', { err: error })
				return c.json(
					createErrorResponse('DATABASE_ERROR', 'An internal error occurred'),
					500,
				)
			}
		})
	}

	// On-demand archival endpoint — for cron triggers (Vercel Cron, AWS EventBridge, etc.)
	if (config.enableArchiver && runArchival) {
		if (!cronSecret && !jwtSecret) {
			logger.error(
				'/api/archive endpoint NOT registered: no authentication configured. ' +
					'Set archiveCronSecret / CRON_SECRET or PG_HISTORY_JWT_SECRET to enable it.',
			)
		} else {
			app.post('/api/archive', async (c) => {
				// Auth contract: when cronSecret is set, verify HMAC here. When only
				// jwtSecret is set, the JWT middleware registered for '/api/*' has
				// already authenticated this request before it reaches the handler.
				if (cronSecret) {
					const ok = await verifyCronSecret(c.req.header('authorization') ?? '')
					if (!ok) {
						return c.json(
							createErrorResponse('UNAUTHORIZED', 'Invalid cron secret'),
							401,
						)
					}
				}

				try {
					await runArchival()
					return c.json({
						success: true,
						archival: {
							status: archivalHealth.status,
							attempts: archivalHealth.attempts,
							lastCompletedAt: archivalHealth.lastCompletedAt,
						},
					})
				} catch (error) {
					logger.error('archival error', { err: error })
					return c.json(
						createErrorResponse('ARCHIVAL_ERROR', 'An internal error occurred'),
						500,
					)
				}
			})
		}
	}

	// Extract the actor (JWT `sub`) and full JWT payload from the request.
	function getAuthContext(c: Context): {
		actor: string | undefined
		jwtPayload: Record<string, unknown> | undefined
	} {
		const jwtPayload = (c as unknown as { get(k: string): unknown }).get(
			'jwtPayload',
		) as Record<string, unknown> | undefined
		const actor =
			jwtPayload && typeof jwtPayload.sub === 'string'
				? jwtPayload.sub
				: undefined
		return { actor, jwtPayload }
	}

	// Run the optional authorization hook. Authentication proves WHO the caller
	// is; this proves they may touch THIS table/record. Without a hook the server
	// grants any authenticated caller blanket access (no tenant isolation), so a
	// multi-tenant deployment MUST supply config.authorize. Throws
	// AuthorizationError (→ 403) on deny; a thrown hook is treated as deny.
	async function authorizeOrThrow(
		c: Context,
		action: 'read' | 'search' | 'revert',
		table: string,
		recordId?: string,
	): Promise<void> {
		if (!config.authorize) return
		const { actor, jwtPayload } = getAuthContext(c)
		let allowed: boolean
		try {
			allowed = await config.authorize({
				actor,
				table,
				recordId,
				action,
				jwtPayload,
			})
		} catch (err) {
			logger.warn('authorize hook threw; denying request', { err })
			throw new AuthorizationError(
				err instanceof Error ? err.message : undefined,
			)
		}
		if (!allowed) throw new AuthorizationError()
	}

	// History API endpoints (only if history enabled)
	if (config.enableHistory && pgHistory) {
		app.get('/api/history/:table/:recordId', async (c) => {
			const pgHistory = c.get('pgHistory')
			if (!pgHistory) {
				return c.json(
					createErrorResponse('NOT_CONFIGURED', 'PgHistory not initialized'),
					500,
				)
			}

			const table = c.req.param('table')
			const recordId = c.req.param('recordId')

			// Validate table name format at the boundary — consistent with POST endpoints.
			// This gives a 400 VALIDATION_ERROR for malformed identifiers rather than
			// leaking the table allowlist via INVALID_TABLE.
			try {
				validateIdentifier(table, 'table')
			} catch {
				return c.json(
					createErrorResponse('VALIDATION_ERROR', 'Invalid table name'),
					400,
				)
			}

			// recordId is interpolated as a query parameter, not into SQL, but
			// length-bound it anyway to keep pathological clients from sending
			// multi-MB strings that the DB still has to evaluate.
			if (typeof recordId !== 'string' || recordId.length === 0) {
				return c.json(
					createErrorResponse('VALIDATION_ERROR', 'recordId is required'),
					400,
				)
			}
			if (recordId.length > 512) {
				return c.json(
					createErrorResponse(
						'VALIDATION_ERROR',
						'recordId exceeds maximum length',
					),
					400,
				)
			}
			if (recordId.includes('\0')) {
				return c.json(
					createErrorResponse(
						'VALIDATION_ERROR',
						'recordId cannot contain null bytes',
					),
					400,
				)
			}

			const limitQuery = c.req.query('limit')
			const cursor = c.req.query('cursor') || undefined
			const orderQuery = c.req.query('order')

			// Parse limit — reject non-numeric strings with 400 instead of
			// handing NaN to validateLimit and getting a 500.
			let limit: number | undefined
			if (limitQuery !== undefined) {
				const parsed = Number.parseInt(limitQuery, 10)
				if (!Number.isFinite(parsed) || String(parsed) !== limitQuery) {
					return c.json(
						createErrorResponse(
							'VALIDATION_ERROR',
							'limit must be a positive integer',
						),
						400,
					)
				}
				limit = parsed
			}

			// Validate order parameter
			if (orderQuery && orderQuery !== 'asc' && orderQuery !== 'desc') {
				return c.json(
					createErrorResponse(
						'VALIDATION_ERROR',
						'order must be "asc" or "desc"',
					),
					400,
				)
			}
			const order = (orderQuery || 'desc') as 'asc' | 'desc'

			try {
				await authorizeOrThrow(c, 'read', table, recordId)
				const result = await pgHistory.getHistory(table, recordId, {
					limit,
					cursor,
					order,
				})
				return c.json(result)
			} catch (error) {
				if (error instanceof AuthorizationError) {
					return c.json(createErrorResponse('FORBIDDEN', error.message), 403)
				}
				if (error instanceof TableNotConfiguredError) {
					return c.json(
						createErrorResponse('INVALID_TABLE', error.message),
						400,
					)
				}
				if (error instanceof ValidationError) {
					return c.json(
						createErrorResponse('VALIDATION_ERROR', error.message),
						400,
					)
				}
				if (error instanceof SetupRequiredError) {
					return c.json(
						createErrorResponse('NOT_CONFIGURED', error.message),
						500,
					)
				}
				logger.error('getHistory error', { err: error })
				return c.json(
					createErrorResponse('DATABASE_ERROR', 'An internal error occurred'),
					500,
				)
			}
		})

		app.post('/api/history/search', async (c) => {
			const pgHistory = c.get('pgHistory')
			if (!pgHistory) {
				return c.json(
					createErrorResponse('NOT_CONFIGURED', 'PgHistory not initialized'),
					500,
				)
			}

			let rawBody: unknown
			try {
				rawBody = await c.req.json()
			} catch {
				return c.json(
					createErrorResponse(
						'VALIDATION_ERROR',
						'Invalid JSON in request body',
					),
					400,
				)
			}

			let options: ReturnType<typeof parseSearchBody>
			try {
				options = parseSearchBody(rawBody)
			} catch (error) {
				if (error instanceof ValidationError) {
					return c.json(
						createErrorResponse('VALIDATION_ERROR', error.message),
						400,
					)
				}
				throw error
			}

			try {
				for (const t of options.tables) {
					await authorizeOrThrow(c, 'search', t)
				}
				const result = await pgHistory.search(options)
				return c.json(result)
			} catch (error) {
				if (error instanceof AuthorizationError) {
					return c.json(createErrorResponse('FORBIDDEN', error.message), 403)
				}
				if (error instanceof SearchConcurrencyLimitError) {
					return c.json(createErrorResponse('RATE_LIMITED', error.message), 429)
				}
				if (error instanceof TableNotConfiguredError) {
					return c.json(
						createErrorResponse('INVALID_TABLE', error.message),
						400,
					)
				}
				if (error instanceof PgHistoryError) {
					return c.json(
						createErrorResponse('VALIDATION_ERROR', error.message),
						400,
					)
				}
				logger.error('search error', { err: error })
				return c.json(
					createErrorResponse('DATABASE_ERROR', 'An internal error occurred'),
					500,
				)
			}
		})

		app.post('/api/history/revert', async (c) => {
			const pgHistory = c.get('pgHistory')
			if (!pgHistory) {
				return c.json(
					createErrorResponse('NOT_CONFIGURED', 'PgHistory not initialized'),
					500,
				)
			}

			let rawBody: unknown
			try {
				rawBody = await c.req.json()
			} catch {
				return c.json(
					createErrorResponse(
						'VALIDATION_ERROR',
						'Invalid JSON in request body',
					),
					400,
				)
			}

			let parsed: {
				table: string
				recordId: string
				auditEntryId: string
				suppressAuditTriggers?: boolean
			}
			try {
				parsed = parseRevertBody(rawBody)
			} catch (error) {
				if (error instanceof ValidationError) {
					return c.json(
						createErrorResponse('VALIDATION_ERROR', error.message),
						400,
					)
				}
				throw error
			}

			// Capture sub from JWT payload (RFC 7519 allows non-string; trust strings only).
			const payload = (c as unknown as { get(k: string): unknown }).get(
				'jwtPayload',
			) as Record<string, unknown> | undefined
			const actor =
				payload && typeof payload.sub === 'string' ? payload.sub : undefined
			logger.info('revert requested', {
				table: parsed.table,
				recordId: parsed.recordId,
				auditEntryId: parsed.auditEntryId,
				actor: actor ?? 'unknown',
			})

			try {
				await authorizeOrThrow(c, 'revert', parsed.table, parsed.recordId)
				await pgHistory.revert(
					parsed.table,
					parsed.recordId,
					parsed.auditEntryId,
					parsed.suppressAuditTriggers !== undefined
						? { suppressAuditTriggers: parsed.suppressAuditTriggers }
						: undefined,
				)
				logger.info('revert completed', {
					table: parsed.table,
					recordId: parsed.recordId,
					auditEntryId: parsed.auditEntryId,
					actor: actor ?? 'unknown',
				})
				return c.json({ success: true })
			} catch (error) {
				if (error instanceof AuthorizationError) {
					return c.json(createErrorResponse('FORBIDDEN', error.message), 403)
				}
				if (error instanceof TableNotConfiguredError) {
					return c.json(
						createErrorResponse('INVALID_TABLE', error.message),
						400,
					)
				}
				if (error instanceof AuditEntryNotFoundError) {
					return c.json(createErrorResponse('NOT_FOUND', error.message), 404)
				}
				if (error instanceof RevertError) {
					return c.json(createErrorResponse('REVERT_ERROR', error.message), 422)
				}
				if (error instanceof ValidationError) {
					return c.json(
						createErrorResponse('VALIDATION_ERROR', error.message),
						400,
					)
				}
				logger.error('revert error', { err: error })
				return c.json(
					createErrorResponse('DATABASE_ERROR', 'An internal error occurred'),
					500,
				)
			}
		})
	}

	// OpenAPI documentation endpoint. The JWT gate above only applies when a JWT
	// secret is configured, so in a cron-only deployment `publicOpenApi: false`
	// would otherwise silently still serve the spec. Fail closed: only register it
	// when it is explicitly public, JWT-gated, or unauthenticated access was opted
	// into. Same contract as /api/stats and /api/health/detailed.
	const exposeOpenApi =
		config.publicOpenApi === true ||
		!!jwtSecret ||
		config.allowUnauthenticated === true
	if (!exposeOpenApi) {
		logger.warn(
			'/openapi NOT registered: publicOpenApi is false and no JWT is configured. ' +
				'Set PG_HISTORY_JWT_SECRET, publicOpenApi: true, or allowUnauthenticated: true.',
		)
	}
	if (exposeOpenApi) {
		app.get(
			'/openapi',
			openAPIRouteHandler(app, {
				documentation: {
					info: {
						title: 'pg-history Archiver API',
						version: '1.0.0',
						description: 'API for managing audit log archival',
					},
					servers: [
						{
							// Prefer an explicit baseUrl, then Vercel deployment URL,
							// then fall back to localhost for local dev.
							url:
								config.baseUrl ||
								(process.env.VERCEL_URL
									? `https://${process.env.VERCEL_URL}`
									: `http://localhost:${config.port || 3001}`),
							description: 'API Server',
						},
					],
				},
			}),
		)
	}

	/**
	 * Graceful shutdown: wait for in-flight requests to drain, then cancel the
	 * archival interval and wait for any running archival to complete.
	 * Call this before closing the pool and exiting.
	 */
	async function dispose(drainTimeoutMs = 15_000): Promise<void> {
		if (disposed) return
		disposed = true
		await waitForInFlightRequests(drainTimeoutMs)
		if (archivalInterval) clearInterval(archivalInterval)
		if (rateLimitCleanupInterval) clearInterval(rateLimitCleanupInterval)
		// Cancel any in-progress retry backoff and resolve its promise so the
		// runArchival loop exits immediately instead of waiting up to 60s.
		if (archivalRetryTimer) clearTimeout(archivalRetryTimer)
		if (archivalRetryResolve) archivalRetryResolve()
		if (currentArchivalPromise) {
			await currentArchivalPromise.catch(() => {})
		}
	}

	return { app, dispose }
}
