import { Hono } from 'hono'
import type { JwtVariables } from 'hono/jwt'
import { jwt } from 'hono/jwt'
import { openAPIRouteHandler } from 'hono-openapi'
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

	// If archiver is enabled, run the orchestrator
	if (config.enableArchiver && config.archiverConfig) {
		console.log('Setting up archiver schema...')
		await setupArchiverSchema(config.pool)

		console.log('Running archival process...')
		const orchestrator = new Orchestrator(
			config.archiverConfig.s3,
			config.archiverConfig.retention,
			config.archiverConfig.gracePeriod,
			config.archiverConfig.batchSize,
		)

		const stats = await orchestrator.run(config.pool, config.runOptions || {})

		console.log('Archival complete', {
			tables: stats.tables.length,
			recordsArchived: stats.totalRecordsArchived,
			recordsSoftDeleted: stats.totalRecordsSoftDeleted,
			recordsHardDeleted: stats.totalRecordsHardDeleted,
			errors: stats.errors.length,
			durationMs: stats.durationMs,
		})

		// Log errors if any
		for (const error of stats.errors) {
			console.error('Table processing error', error)
		}
	}

	// Conditionally apply JWT auth if PG_HISTORY_JWT_SECRET is set
	const jwtSecret = process.env.PG_HISTORY_JWT_SECRET
	if (jwtSecret) {
		console.log('JWT authentication enabled')
		app.use('/api/*', (c, next) => {
			const jwtMiddleware = jwt({
				secret: jwtSecret,
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
