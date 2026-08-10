#!/usr/bin/env node
/**
 * Bun entrypoint — run with: bun run src/main.ts
 *
 * Reads connection and feature config from environment variables and starts
 * the Hono HTTP server. Not imported by library consumers.
 */
import { consoleLogger, endPoolWithTimeout } from './logger'
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
	// Bound every pool query so a stuck connection can't wedge the process.
	// statement_timeout defaults to 30s; raise PG_HISTORY_STATEMENT_TIMEOUT_MS
	// (or set 0 to disable) if a one-time archiver index build on a large,
	// pre-existing audit_log needs longer. The archiver's own transactions set
	// their own SET LOCAL statement_timeout and are unaffected.
	const statementTimeoutMs = Number.parseInt(
		process.env.PG_HISTORY_STATEMENT_TIMEOUT_MS || '30000',
		10,
	)
	const pool = new Pool({
		connectionString: databaseUrl,
		max: poolMax,
		connectionTimeoutMillis: 10_000,
		idleTimeoutMillis: 30_000,
		statement_timeout: Number.isFinite(statementTimeoutMs)
			? statementTimeoutMs
			: 30_000,
		idle_in_transaction_session_timeout: 60_000,
	})

	const port = Number.parseInt(
		process.env.PG_HISTORY_PORT || process.env.PORT || '3001',
		10,
	)

	// Enable the history API when tables are configured. Without this the server
	// would bind the port and answer /health but expose no functional endpoints.
	const tables =
		process.env.PG_HISTORY_TABLES?.split(',')
			.map((t) => t.trim())
			.filter(Boolean) || []

	// Optionally wire the S3 archiver when a bucket is configured.
	let archiverConfig: Parameters<typeof createServer>[0]['archiverConfig']
	if (process.env.PG_HISTORY_S3_BUCKET) {
		const boundedInt = (
			envVar: string,
			fallback: number,
			min: number,
		): number => {
			const parsed = Number.parseInt(
				process.env[envVar] || String(fallback),
				10,
			)
			if (!Number.isFinite(parsed) || parsed < min) {
				throw new Error(
					`${envVar} must be an integer >= ${min} (got: ${process.env[envVar]})`,
				)
			}
			return parsed
		}
		archiverConfig = {
			s3: {
				bucket: process.env.PG_HISTORY_S3_BUCKET,
				endpoint: process.env.PG_HISTORY_S3_ENDPOINT,
				region: process.env.PG_HISTORY_S3_REGION,
				accessKeyId: process.env.PG_HISTORY_S3_ACCESS_KEY_ID,
				secretAccessKey: process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY,
			},
			retention: { default: boundedInt('PG_HISTORY_RETENTION_DAYS', 90, 1) },
			// gracePeriod may be 0 (no grace — purge once the S3 backup is confirmed).
			gracePeriod: boundedInt('PG_HISTORY_GRACE_PERIOD_DAYS', 7, 0),
			batchSize: boundedInt('PG_HISTORY_BATCH_SIZE', 10000, 1),
		}
	}

	const { app, dispose } = await createServer({
		pool,
		port,
		logger: startupLogger,
		enableHistory: tables.length > 0,
		historyConfig: tables.length > 0 ? { tables } : undefined,
		enableArchiver: !!process.env.PG_HISTORY_S3_BUCKET,
		archiverConfig,
		// Fail closed: createServer throws if history is enabled without a JWT
		// secret unless this explicit opt-in is set (local dev / trusted network).
		allowUnauthenticated:
			process.env.PG_HISTORY_ALLOW_UNAUTHENTICATED === 'true',
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
			// Bounded: a bare pool.end() waits forever on a client still held by a
			// hung query, which would blow past Fly's kill_timeout and get SIGKILLed.
			await endPoolWithTimeout(pool, 10_000, startupLogger, 'main')
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
