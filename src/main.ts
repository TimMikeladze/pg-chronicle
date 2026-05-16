/**
 * Bun entrypoint — run with: bun run src/main.ts
 *
 * Reads connection and feature config from environment variables and starts
 * the Hono HTTP server. Not imported by library consumers.
 */
import { consoleLogger } from './logger'
import { createServer } from './server'

interface BunServer {
	stop(): void
}
interface BunRuntime {
	serve(config: {
		port: number
		fetch: (req: Request) => Response | Promise<Response>
	}): BunServer
}
declare const Bun: BunRuntime

;(async () => {
	const { Pool } = await import('pg')
	const startupLogger = consoleLogger

	const databaseUrl = process.env.PG_HISTORY_DATABASE_URL
	if (!databaseUrl) {
		throw new Error('PG_HISTORY_DATABASE_URL environment variable is required')
	}

	const poolMax = Number.parseInt(process.env.PG_HISTORY_POOL_MAX || '5', 10)
	if (!Number.isFinite(poolMax) || poolMax < 1) {
		throw new Error(
			`PG_HISTORY_POOL_MAX must be a positive integer (got: ${process.env.PG_HISTORY_POOL_MAX})`,
		)
	}
	const pool = new Pool({
		connectionString: databaseUrl,
		max: poolMax,
	})

	const port = Number.parseInt(
		process.env.PG_HISTORY_PORT || process.env.PORT || '3001',
		10,
	)

	const { app, dispose } = await createServer({
		pool,
		port,
		logger: startupLogger,
	})

	startupLogger.info('Starting server', { port })
	const server = Bun.serve({
		port,
		fetch: app.fetch,
	})

	// Graceful shutdown — stop accepting new requests, drain in-flight
	// handlers and archival via dispose(), then close the pool.
	const SHUTDOWN_DRAIN_TIMEOUT_MS = 15_000
	const shutdown = async (signal: string): Promise<void> => {
		startupLogger.info('Received signal, shutting down gracefully', { signal })
		let exitCode = 0
		try {
			server.stop()
			await dispose(SHUTDOWN_DRAIN_TIMEOUT_MS)
			await pool.end()
		} catch (err) {
			startupLogger.error('Error during shutdown', { err })
			exitCode = 1
		}
		process.exit(exitCode)
	}

	process.on('SIGTERM', () => shutdown('SIGTERM'))
	process.on('SIGINT', () => shutdown('SIGINT'))
})().catch((err) => {
	consoleLogger.error('Fatal error starting server', { err })
	process.exit(1)
})
