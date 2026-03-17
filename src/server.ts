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
} from './errors'
import { Orchestrator } from './orchestrator'
import { PgHistory } from './PgHistory'
import { getArchivalStats, setupArchiverSchema } from './schema'
import type { ServerConfig } from './types'

type Variables = JwtVariables & {
	pgHistory?: PgHistory
}

export async function createServer(
	config: ServerConfig,
): Promise<Hono<{ Variables: Variables }>> {
	const app = new Hono<{ Variables: Variables }>()

	// Limit request body size to 1MB to prevent memory exhaustion
	app.use('/api/*', bodyLimit({ maxSize: 1024 * 1024 }))

	// In-memory rate limiter — only useful in long-running processes, skip in serverless
	if (!config.serverless) {
		const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
		const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
		const RATE_LIMIT_MAX = 100 // requests per window

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

			// Periodically clean up expired entries
			if (rateLimitMap.size > 10_000) {
				for (const [key, val] of rateLimitMap) {
					if (now > val.resetAt) rateLimitMap.delete(key)
				}
			}

			await next()
		})
	}

	// Initialize PgHistory if enabled
	let pgHistory: PgHistory | undefined
	if (config.enableHistory && config.historyConfig) {
		console.log('Initializing PgHistory API...')
		pgHistory = new PgHistory({
			tables: config.historyConfig.tables,
			pool: config.pool,
		})
		await pgHistory.setup()
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
		console.log('Setting up archiver schema...')
		await setupArchiverSchema(config.pool)

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

						const orchestrator = new Orchestrator(
							archiverConfig.s3,
							archiverConfig.retention,
							archiverConfig.gracePeriod,
							archiverConfig.batchSize,
						)

						const stats = await orchestrator.run(config.pool, runOptions)

						console.log('Archival complete', {
							tables: stats.tables.length,
							recordsArchived: stats.totalRecordsArchived,
							recordsSoftDeleted: stats.totalRecordsSoftDeleted,
							recordsHardDeleted: stats.totalRecordsHardDeleted,
							errors: stats.errors.length,
							durationMs: stats.durationMs,
						})

						for (const error of stats.errors) {
							console.error('Table processing error', error)
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
							console.error(
								`Background archival failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${delay / 1000}s:`,
								message,
							)
							await new Promise((r) => setTimeout(r, delay))
						} else {
							console.error(
								`Background archival failed after ${MAX_RETRIES + 1} attempts:`,
								message,
							)
						}
					}
				}
			} finally {
				archivalRunning = false
			}
		}

		// In long-running mode: run immediately + schedule periodic runs
		if (!config.serverless) {
			// Track the currently running archival for graceful shutdown
			let currentArchivalPromise: Promise<void> | null = null

			const trackAndRun = (): Promise<void> => {
				const p = runArchival()
				currentArchivalPromise = p
				p.finally(() => {
					if (currentArchivalPromise === p) currentArchivalPromise = null
				})
				return p
			}

			console.log('Running archival process in background...')
			trackAndRun()

			const intervalMs =
				Number.parseInt(
					process.env.PG_HISTORY_ARCHIVAL_INTERVAL_MS || '3600000',
					10,
				) || 3_600_000
			const archivalInterval = setInterval(() => {
				console.log('Running scheduled archival...')
				trackAndRun().catch((err) => {
					console.error('Scheduled archival failed:', err)
				})
			}, intervalMs)

			const appState = app as unknown as Record<string, unknown>
			appState._archivalPromise = () => currentArchivalPromise
			appState._archivalInterval = archivalInterval
		}
	}

	// Conditionally apply JWT auth if PG_HISTORY_JWT_SECRET is set
	const jwtSecret = process.env.PG_HISTORY_JWT_SECRET
	if (jwtSecret) {
		console.log('JWT authentication enabled')
		app.use('/api/*', (c, next) => {
			const jwtMiddleware = jwt({
				secret: jwtSecret,
				alg: 'HS256',
			})
			return jwtMiddleware(c, next)
		})
	}

	// Health check endpoint (no auth required)
	app.get('/health', (c) => {
		const health: Record<string, unknown> = { status: 'ok' }
		if (config.enableArchiver) {
			health.archival = archivalHealth
			if (archivalHealth.status === 'failed') {
				health.status = 'degraded'
			}
		}
		return c.json(health)
	})

	// Archival stats endpoint (fast - no audit_log scan)
	// Only available if archiver is enabled
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

		app.post('/api/archive', async (c) => {
			// Verify cron secret if configured
			if (cronSecret) {
				const authHeader = c.req.header('authorization')
				if (authHeader !== `Bearer ${cronSecret}`) {
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
				const message = error instanceof Error ? error.message : String(error)
				return c.json(createErrorResponse('ARCHIVAL_ERROR', message), 500)
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
			const limit = limitQuery ? Number.parseInt(limitQuery, 10) : undefined
			const cursor = c.req.query('cursor') || undefined
			const orderQuery = c.req.query('order')

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
				if (error instanceof SetupRequiredError) {
					return c.json(
						createErrorResponse('NOT_CONFIGURED', error.message),
						500,
					)
				}
				const message = error instanceof Error ? error.message : String(error)
				return c.json(createErrorResponse('DATABASE_ERROR', message), 500)
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

			let body: Record<string, unknown>
			try {
				body = await c.req.json()
			} catch {
				return c.json(
					createErrorResponse(
						'VALIDATION_ERROR',
						'Invalid JSON in request body',
					),
					400,
				)
			}

			// Validate required fields
			if (
				!body.tables ||
				!Array.isArray(body.tables) ||
				body.tables.length === 0
			) {
				return c.json(
					createErrorResponse(
						'VALIDATION_ERROR',
						'tables array is required and must not be empty',
					),
					400,
				)
			}

			try {
				const result = await pgHistory.search({
					tables: body.tables as string[],
					query: body.query as string | undefined,
					operation: body.operation as
						| 'INSERT'
						| 'UPDATE'
						| 'DELETE'
						| undefined,
					dateFrom: body.dateFrom
						? new Date(body.dateFrom as string)
						: undefined,
					dateTo: body.dateTo ? new Date(body.dateTo as string) : undefined,
					limit: body.limit as number | undefined,
					cursor: body.cursor as string | undefined,
				})
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
				const message = error instanceof Error ? error.message : String(error)
				return c.json(createErrorResponse('DATABASE_ERROR', message), 500)
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

			let body: Record<string, unknown>
			try {
				body = await c.req.json()
			} catch {
				return c.json(
					createErrorResponse(
						'VALIDATION_ERROR',
						'Invalid JSON in request body',
					),
					400,
				)
			}

			const { table, recordId, auditEntryId } = body as {
				table?: string
				recordId?: string
				auditEntryId?: string
			}

			if (!table || !recordId || !auditEntryId) {
				return c.json(
					createErrorResponse(
						'VALIDATION_ERROR',
						'table, recordId, and auditEntryId are required',
					),
					400,
				)
			}

			try {
				await pgHistory.revert(table, recordId, auditEntryId)
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
				const message = error instanceof Error ? error.message : String(error)
				return c.json(createErrorResponse('DATABASE_ERROR', message), 500)
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

// If this file is run directly (e.g. `bun server.ts`), create and start the server
if (import.meta.main) {
	;(async () => {
		const { Pool } = await import('pg')

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

		const app = await createServer({ pool, port })

		console.log(`Starting server on port ${port}`)
		const server = Bun.serve({
			port,
			fetch: app.fetch,
		})

		// Graceful shutdown
		const appState = app as unknown as Record<string, unknown>
		const getArchivalPromise = appState._archivalPromise as
			| (() => Promise<void> | null)
			| undefined
		const archivalInterval = appState._archivalInterval as
			| ReturnType<typeof setInterval>
			| undefined

		const shutdown = async (signal: string) => {
			console.log(`Received ${signal}, shutting down gracefully...`)
			server.stop()
			if (archivalInterval) clearInterval(archivalInterval)
			const currentPromise = getArchivalPromise?.()
			if (currentPromise) {
				console.log('Waiting for background archival to complete...')
				await currentPromise.catch(() => {})
			}
			await pool.end()
			process.exit(0)
		}

		process.on('SIGTERM', () => shutdown('SIGTERM'))
		process.on('SIGINT', () => shutdown('SIGINT'))
	})().catch(console.error)
}
