#!/usr/bin/env node
/**
 * Server entrypoint — `bun run src/main.ts`, or the published `pg-history` bin
 * under Node.
 *
 * Reads connection and feature config from environment variables and starts
 * the Hono HTTP server. Not imported by library consumers.
 */
import type { Logger } from './logger'
import { consoleLogger, endPoolWithTimeout } from './logger'
import { createServer } from './server'

type FetchHandler = (req: Request) => Response | Promise<Response>

interface BunServer {
	stop(): void
}
interface BunRuntime {
	serve(config: { port: number; fetch: FetchHandler }): BunServer
}

/** Uniform handle over the Bun and Node servers. */
interface RunningServer {
	stop(): Promise<void>
}

/**
 * Bind the port using whichever runtime we are on.
 *
 * This file is the package's `bin`, and its shebang says `node` — so it has to
 * work there. `Bun.serve` is only reachable when Bun is actually the host;
 * under Node we load the standard Hono adapter instead. The adapter import is
 * dynamic so Bun never pays for loading it.
 */
async function listen(
	port: number,
	fetchHandler: FetchHandler,
	logger: Logger,
): Promise<RunningServer> {
	const bun = (globalThis as { Bun?: BunRuntime }).Bun
	if (typeof bun?.serve === 'function') {
		logger.info('Serving with Bun.serve', { port })
		const server = bun.serve({ port, fetch: fetchHandler })
		return { stop: async () => server.stop() }
	}

	logger.info('Serving with @hono/node-server', { port })
	const { serve } = await import('@hono/node-server')
	const server = serve({ fetch: fetchHandler, port })
	return {
		// `close()` stops accepting new connections but waits for existing ones,
		// and an idle keep-alive socket keeps it waiting forever. Bound it: the
		// drain that matters (in-flight request handlers) is dispose()'s job, and
		// blocking here would blow past the platform's kill timeout and turn a
		// graceful shutdown into a SIGKILL.
		stop: () =>
			new Promise<void>((resolve) => {
				const timer = setTimeout(() => {
					logger.warn('HTTP server did not close in time; forcing', {
						timeoutMs: SERVER_CLOSE_TIMEOUT_MS,
					})
					// Node 18.2+; severs lingering keep-alive sockets so close() lands.
					const closeAll = (
						server as unknown as { closeAllConnections?: () => void }
					).closeAllConnections
					if (typeof closeAll === 'function') closeAll.call(server)
					resolve()
				}, SERVER_CLOSE_TIMEOUT_MS)
				timer.unref?.()
				server.close(() => {
					clearTimeout(timer)
					resolve()
				})
			}),
	}
}

/**
 * Shutdown budget. The three phases run in sequence, so their timeouts ADD UP,
 * and the total has to stay under the platform's kill timeout — `fly.toml` sets
 * `kill_timeout = '30s'`, and anything past that is a SIGKILL in the middle of
 * archival rather than a graceful stop.
 *
 *   close listener   2s  ┐
 *   drain + archival 15s ├─ 27s, 3s of headroom
 *   close pool       10s ┘
 *
 * Closing the listener gets the smallest share on purpose: it only stops new
 * connections, and the drain that actually matters (in-flight handlers, a
 * running archival) is the next phase's job.
 */
const SERVER_CLOSE_TIMEOUT_MS = 2_000
const SHUTDOWN_DRAIN_TIMEOUT_MS = 15_000
const POOL_CLOSE_TIMEOUT_MS = 10_000

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
	const server = await listen(port, app.fetch, startupLogger)

	// Graceful shutdown — stop accepting new requests, drain in-flight
	// handlers and archival via dispose(), then close the pool. Each phase is
	// bounded; see the shutdown budget above for why the three have to sum to
	// less than the platform's kill timeout.
	const shutdown = async (signal: string): Promise<void> => {
		startupLogger.info('Received signal, shutting down gracefully', { signal })
		let exitCode = 0
		try {
			await server.stop()
			await dispose(SHUTDOWN_DRAIN_TIMEOUT_MS)
			// Bounded: a bare pool.end() waits forever on a client still held by a
			// hung query, which would blow past Fly's kill_timeout and get SIGKILLed.
			await endPoolWithTimeout(
				pool,
				POOL_CLOSE_TIMEOUT_MS,
				startupLogger,
				'main',
			)
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
