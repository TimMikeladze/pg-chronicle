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
	SetupRequiredError,
	TableNotConfiguredError,
	ValidationError,
} from './errors'
import { consoleLogger, type Logger } from './logger'
import { Orchestrator } from './orchestrator'
import { PgHistory } from './PgHistory'
import { getArchivalStats, setupArchiverSchema } from './schema'
import type { ServerConfig } from './types'
import { parseRevertBody, parseSearchBody } from './validation'

type Variables = JwtVariables & {
	pgHistory?: PgHistory
}

// Module-level archival state for graceful shutdown coordination
let currentArchivalPromise: Promise<void> | null = null
let archivalInterval: ReturnType<typeof setInterval> | undefined
let rateLimitCleanupInterval: ReturnType<typeof setInterval> | undefined
// In-flight request count — used by graceful shutdown to wait for drain
let inFlightRequests = 0
const inFlightWaiters: Array<() => void> = []

async function waitForInFlightRequests(timeoutMs: number): Promise<void> {
	if (inFlightRequests === 0) return
	await new Promise<void>((resolve) => {
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

export async function createServer(
	config: ServerConfig,
): Promise<Hono<{ Variables: Variables }>> {
	const app = new Hono<{ Variables: Variables }>()
	const logger: Logger = config.logger ?? consoleLogger

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
		const MAX_RETRIES = 3
		const RETRY_DELAYS = [5_000, 15_000, 60_000] // 5s, 15s, 60s
		let archivalRunning = false

		runArchival = async (): Promise<void> => {
			if (archivalRunning) return // prevent overlapping runs
			archivalRunning = true

			try {
				for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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

						if (attempt < MAX_RETRIES) {
							const delay = RETRY_DELAYS[attempt] || 60_000
							logger.error('Background archival failed, retrying', {
								attempt: attempt + 1,
								maxAttempts: MAX_RETRIES + 1,
								delayMs: delay,
								message,
							})
							await new Promise((r) => setTimeout(r, delay))
						} else {
							logger.error('Background archival failed after all attempts', {
								attempts: MAX_RETRIES + 1,
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
		}
	}

	// Conditionally apply JWT auth if PG_HISTORY_JWT_SECRET is set.
	// When set, we also gate the /openapi endpoint by default unless the
	// consumer explicitly opts into publicOpenApi.
	const jwtSecret = process.env.PG_HISTORY_JWT_SECRET
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
			const stats = await getArchivalStats(config.pool)
			return c.json({ stats })
		})
	}

	// On-demand archival endpoint — for cron triggers (Vercel Cron, AWS EventBridge, etc.)
	// Authenticated via archiveCronSecret config or CRON_SECRET env var (Vercel convention)
	if (config.enableArchiver && runArchival) {
		const cronSecret = config.archiveCronSecret || process.env.CRON_SECRET
		if (!cronSecret) {
			logger.warn(
				'/api/archive endpoint has no authentication. Set archiveCronSecret or CRON_SECRET env var.',
			)
		}

		app.post('/api/archive', async (c) => {
			// Verify cron secret using timing-safe comparison to prevent timing attacks
			if (cronSecret) {
				const authHeader = c.req.header('authorization') ?? ''
				const expected = `Bearer ${cronSecret}`
				const a = Buffer.from(authHeader)
				const b = Buffer.from(expected)
				if (a.length !== b.length || !timingSafeEqual(a, b)) {
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
					archival: archivalHealth,
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
						url: `http://localhost:${config.port || 3001}`,
						description: 'Local Server',
					},
				],
			},
		}),
	)

	return app
}

// If this file is run directly under Bun (e.g. `bun server.ts`), create and
// start the server. Gated on `typeof Bun !== 'undefined'` so importing this
// module from a Node.js or Vercel environment doesn't reference `Bun` globally.
interface BunServer {
	stop(): void
}
interface BunRuntime {
	serve(config: {
		port: number
		fetch: (req: Request) => Response | Promise<Response>
	}): BunServer
}
declare const Bun: BunRuntime | undefined
if (typeof Bun !== 'undefined' && import.meta.main) {
	;(async () => {
		const { Pool } = await import('pg')
		const startupLogger = consoleLogger

		const databaseUrl = process.env.PG_HISTORY_DATABASE_URL
		if (!databaseUrl) {
			throw new Error(
				'PG_HISTORY_DATABASE_URL environment variable is required',
			)
		}

		const poolMax = Number.parseInt(process.env.PG_HISTORY_POOL_MAX || '5', 10)
		const pool = new Pool({
			connectionString: databaseUrl,
			max: poolMax,
		})

		const port = Number.parseInt(
			process.env.PG_HISTORY_PORT || process.env.PORT || '3001',
			10,
		)

		const app = await createServer({ pool, port, logger: startupLogger })

		startupLogger.info('Starting server', { port })
		const server = Bun.serve({
			port,
			fetch: app.fetch,
		})

		// Graceful shutdown — stop accepting new requests, wait for in-flight
		// handlers to finish (with a bounded timeout), drain archival, then
		// close the pool.
		const SHUTDOWN_DRAIN_TIMEOUT_MS = 15_000
		const shutdown = async (signal: string): Promise<void> => {
			startupLogger.info('Received signal, shutting down gracefully', {
				signal,
			})
			// Stop accepting new connections
			server.stop()
			// Drain in-flight requests before cleanup
			await waitForInFlightRequests(SHUTDOWN_DRAIN_TIMEOUT_MS)
			if (archivalInterval) clearInterval(archivalInterval)
			if (rateLimitCleanupInterval) clearInterval(rateLimitCleanupInterval)
			if (currentArchivalPromise) {
				startupLogger.info('Waiting for background archival to complete')
				await currentArchivalPromise.catch(() => {})
			}
			await pool.end()
			process.exit(0)
		}

		process.on('SIGTERM', () => shutdown('SIGTERM'))
		process.on('SIGINT', () => shutdown('SIGINT'))
	})().catch((err) => {
		consoleLogger.error('Fatal error starting server', { err })
		process.exit(1)
	})
}
