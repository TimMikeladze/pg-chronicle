import { Hono } from 'hono'
import type { JwtVariables } from 'hono/jwt'
import { jwt } from 'hono/jwt'
import { openAPIRouteHandler } from 'hono-openapi'
import { createErrorResponse } from './api-helpers'
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

	// Initialize PgHistory if enabled
	let pgHistory: PgHistory | undefined
	if (config.enableHistory && config.historyConfig) {
		console.log('Initializing PgHistory API...')
		pgHistory = new PgHistory({
			tables: config.historyConfig.tables,
			pool: config.pool,
		})
	}

	// Store in context for route handlers
	app.use('*', async (c, next) => {
		if (pgHistory) {
			c.set('pgHistory', pgHistory)
		}
		await next()
	})

	// If archiver is enabled, set up schema synchronously (fast DDL),
	// then run the orchestrator in the background so the server can start
	// accepting requests immediately.
	if (config.enableArchiver && config.archiverConfig) {
		console.log('Setting up archiver schema...')
		await setupArchiverSchema(config.pool)

		const archiverConfig = config.archiverConfig
		const runOptions = config.runOptions || {}

		// Run archival in the background — don't block server startup
		const archivalPromise = (async () => {
			console.log('Running archival process in background...')
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
		})().catch((err) => {
			console.error('Background archival failed:', err)
		})

		// Attach to app for testing/awaiting if needed
		;(app as unknown as Record<string, unknown>)._archivalPromise =
			archivalPromise
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
		return c.json({ status: 'ok' })
	})

	// Archival stats endpoint (fast - no audit_log scan)
	// Only available if archiver is enabled
	if (config.enableArchiver) {
		app.get('/api/stats', async (c) => {
			const stats = await getArchivalStats(config.pool)
			return c.json({ stats })
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
				const message = error instanceof Error ? error.message : String(error)

				if (message.includes('not configured')) {
					return c.json(createErrorResponse('INVALID_TABLE', message), 400)
				}

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
				const message = error instanceof Error ? error.message : String(error)

				if (message.includes('not configured')) {
					return c.json(createErrorResponse('INVALID_TABLE', message), 400)
				}

				if (message.includes('must be') || message.includes('invalid')) {
					return c.json(createErrorResponse('VALIDATION_ERROR', message), 400)
				}

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
				const message = error instanceof Error ? error.message : String(error)

				if (message.includes('not configured')) {
					return c.json(createErrorResponse('INVALID_TABLE', message), 400)
				}

				if (message.includes('not found')) {
					return c.json(createErrorResponse('NOT_FOUND', message), 404)
				}

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
if (require.main === module) {
	;(async () => {
		const { Pool } = await import('pg')

		const databaseUrl = process.env.PG_HISTORY_DATABASE_URL
		if (!databaseUrl) {
			throw new Error(
				'PG_HISTORY_DATABASE_URL environment variable is required',
			)
		}

		const pool = new Pool({ connectionString: databaseUrl })

		const port = process.env.PG_HISTORY_PORT
			? Number.parseInt(process.env.PG_HISTORY_PORT, 10)
			: 3001

		const app = await createServer({ pool, port })

		console.log(`Starting server on port ${port}`)
		const server = Bun.serve({
			port,
			fetch: app.fetch,
		})

		// Graceful shutdown
		process.on('SIGTERM', async () => {
			console.log('Received SIGTERM, shutting down gracefully...')
			server.stop()
			await pool.end()
			process.exit(0)
		})

		process.on('SIGINT', async () => {
			console.log('Received SIGINT, shutting down gracefully...')
			server.stop()
			await pool.end()
			process.exit(0)
		})
	})().catch(console.error)
}
