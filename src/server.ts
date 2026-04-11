import { timingSafeEqual } from 'node:crypto'
import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import type { JwtVariables } from 'hono/jwt'
import { jwt } from 'hono/jwt'
import { openAPIRouteHandler } from 'hono-openapi'
import { createErrorResponse } from './api-helpers'
import {
	AuditEntryNotFoundError,
	PgHistoryError,
	RevertError,
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

	// Instance-scoped state — not module-level globals, so multiple createServer()
	// calls (tests, hot reload) each get their own isolated state.
	let currentArchivalPromise: Promise<void> | null = null
	let archivalInterval: ReturnType<typeof setInterval> | undefined
	let rateLimitCleanupInterval: ReturnType<typeof setInterval> | undefined
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
	// NOTE: x-forwarded-for is client-spoofable. This rate limiter only works correctly
	// behind a trusted reverse proxy that overwrites the header. For production, use
	// API gateway-level rate limiting or ensure your proxy strips client-provided headers.
	if (!config.serverless) {
		const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
		const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
		const RATE_LIMIT_MAX = 100 // requests per window
		const RATE_LIMIT_CLEANUP_INTERVAL_MS = 30_000 // sweep every 30s

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
			const ip =
				c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
				c.req.header('x-real-ip') ||
				'unknown'

			const now = Date.now()
			const entry = rateLimitMap.get(ip)

			if (!entry || now > entry.resetAt) {
				rateLimitMap.set(ip, {
					count: 1,
					resetAt: now + RATE_LIMIT_WINDOW_MS,
				})
			} else {
				entry.count++
				if (entry.count > RATE_LIMIT_MAX) {
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
		logger.info('Setting up archiver schema')
		await setupArchiverSchema(config.pool)
		// If PgHistory is also enabled, the soft-delete column now exists
		if (pgHistory) pgHistory.invalidateSoftDeleteColumnCache()

		const archiverConfig = config.archiverConfig
		const runOptions = config.runOptions || {}
		// MAX_ATTEMPTS: total runs including the initial attempt.
		// RETRY_DELAYS: one entry per retry (MAX_ATTEMPTS - 1 entries).
		const MAX_ATTEMPTS = 4
		const RETRY_DELAYS = [5_000, 15_000, 60_000] // 3 retries after the initial attempt
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

						archivalHealth.status = 'completed'
						archivalHealth.lastError = null
						archivalHealth.lastCompletedAt = new Date()
						return
					} catch (err) {
						const message = err instanceof Error ? err.message : String(err)
						archivalHealth.status = 'failed'
						archivalHealth.lastError = message

						if (attempt < MAX_ATTEMPTS - 1) {
							const delay = RETRY_DELAYS[attempt] ?? 60_000
							logger.error('Background archival failed, retrying', {
								attempt: attempt + 1,
								maxAttempts: MAX_ATTEMPTS,
								delayMs: delay,
								message,
							})
							await new Promise((r) => setTimeout(r, delay))
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

	// Conditionally apply JWT auth if PG_HISTORY_JWT_SECRET is set.
	// When set, we also gate the /openapi endpoint by default unless the
	// consumer explicitly opts into publicOpenApi.
	// Trim to catch accidental empty-string values (would otherwise silently
	// disable auth while `jwtSecret` is falsy).
	const jwtSecret = process.env.PG_HISTORY_JWT_SECRET?.trim() || undefined
	if (jwtSecret) {
		logger.info('JWT authentication enabled')
		const jwtMiddleware = jwt({ secret: jwtSecret, alg: 'HS256' })
		app.use('/api/*', (c, next) => jwtMiddleware(c, next))
		if (!config.publicOpenApi) {
			app.use('/openapi', (c, next) => jwtMiddleware(c, next))
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

	// Health check endpoint (no auth required)
	// Only expose safe status fields — never internal error messages
	app.get('/health', (c) => {
		const health: Record<string, unknown> = { status: 'ok' }
		if (config.enableArchiver) {
			health.archival = {
				status: archivalHealth.status,
				attempts: archivalHealth.attempts,
				lastCompletedAt: archivalHealth.lastCompletedAt,
			}
			if (archivalHealth.status === 'failed') {
				health.status = 'degraded'
			}
		}
		return c.json(health)
	})

	// Archival stats endpoint — protected by JWT (registered above)
	// Moved after JWT middleware so it's auth-gated when JWT is configured
	if (config.enableArchiver) {
		app.get('/api/stats', async (c) => {
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
	// Authenticated via archiveCronSecret config or CRON_SECRET env var (Vercel convention).
	// If neither is set AND no JWT is configured, the endpoint would be fully unauthenticated
	// on an internet-accessible deployment — refuse to register it rather than allow that.
	if (config.enableArchiver && runArchival) {
		const cronSecret =
			(config.archiveCronSecret || process.env.CRON_SECRET)?.trim() || undefined

		if (!cronSecret && !jwtSecret) {
			logger.error(
				'/api/archive endpoint NOT registered: no authentication configured. ' +
					'Set archiveCronSecret / CRON_SECRET or PG_HISTORY_JWT_SECRET to enable it.',
			)
		} else {
			app.post('/api/archive', async (c) => {
				// Auth contract: at least one of the two guards below is always active.
				// The outer `if (!cronSecret && !jwtSecret)` prevents this route from
				// being registered unless one is configured, so we can never reach here
				// with both missing.
				//
				// Case 1: cronSecret is set — verify it here with HMAC-based comparison.
				//   HMAC digests have fixed length (32 bytes), so timingSafeEqual never
				//   needs a length pre-check that would leak the secret length.
				// Case 2: only jwtSecret is set — the JWT middleware registered above
				//   for '/api/*' already verified the token before reaching this handler.
				if (cronSecret) {
					const { createHmac } = await import('node:crypto')
					const authHeader = c.req.header('authorization') ?? ''
					const expected = `Bearer ${cronSecret}`
					const key = Buffer.from(cronSecret)
					const mac = (v: string) =>
						createHmac('sha256', key).update(v).digest()
					if (!timingSafeEqual(mac(authHeader), mac(expected))) {
						return c.json(
							createErrorResponse('UNAUTHORIZED', 'Invalid cron secret'),
							401,
						)
					}
				}
				// else: jwtSecret-only path — JWT middleware already authenticated above.

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
				const result = await pgHistory.getHistory(table, recordId, {
					limit,
					cursor,
					order,
				})
				return c.json(result)
			} catch (error) {
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
				const result = await pgHistory.search(options)
				return c.json(result)
			} catch (error) {
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

			let parsed: { table: string; recordId: string; auditEntryId: string }
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

			try {
				await pgHistory.revert(
					parsed.table,
					parsed.recordId,
					parsed.auditEntryId,
				)
				return c.json({ success: true })
			} catch (error) {
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

	// OpenAPI documentation endpoint (no auth required)
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

	/**
	 * Graceful shutdown: wait for in-flight requests to drain, then cancel the
	 * archival interval and wait for any running archival to complete.
	 * Call this before closing the pool and exiting.
	 */
	async function dispose(drainTimeoutMs = 15_000): Promise<void> {
		await waitForInFlightRequests(drainTimeoutMs)
		if (archivalInterval) clearInterval(archivalInterval)
		if (rateLimitCleanupInterval) clearInterval(rateLimitCleanupInterval)
		if (currentArchivalPromise) {
			await currentArchivalPromise.catch(() => {})
		}
	}

	return { app, dispose }
}
