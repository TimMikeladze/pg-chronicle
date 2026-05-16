import { handle } from 'hono/vercel'
import { consoleLogger } from './logger'
import { createServer } from './server'

// Infer the Hono app type from createServer to avoid type casts
type App = Awaited<ReturnType<typeof createServer>>['app']

// Module-level cache — survives across warm invocations
let cachedApp: App | null = null
let initPromise: Promise<App> | null = null

function getApp(): Promise<App> {
	if (cachedApp) return Promise.resolve(cachedApp)
	if (initPromise) return initPromise

	initPromise = (async () => {
		const pg = await import('pg')

		const databaseUrl = process.env.PG_HISTORY_DATABASE_URL
		if (!databaseUrl) {
			throw new Error(
				'PG_HISTORY_DATABASE_URL environment variable is required',
			)
		}

		const poolMax = Number.parseInt(process.env.PG_HISTORY_POOL_MAX || '3', 10)
		if (!Number.isFinite(poolMax) || poolMax < 1) {
			throw new Error(
				`PG_HISTORY_POOL_MAX must be a positive integer (got: ${process.env.PG_HISTORY_POOL_MAX})`,
			)
		}
		const pool = new pg.default.Pool({
			connectionString: databaseUrl,
			max: poolMax,
		})

		const tables =
			process.env.PG_HISTORY_TABLES?.split(',')
				.map((t) => t.trim())
				.filter(Boolean) || []
		if (tables.length === 0) {
			throw new Error(
				'PG_HISTORY_TABLES environment variable is required (comma-separated table names)',
			)
		}

		let archiverConfig: Parameters<typeof createServer>[0]['archiverConfig']
		if (process.env.PG_HISTORY_S3_BUCKET) {
			const retentionDays = Number.parseInt(
				process.env.PG_HISTORY_RETENTION_DAYS || '90',
				10,
			)
			if (!Number.isFinite(retentionDays) || retentionDays < 1) {
				throw new Error(
					`PG_HISTORY_RETENTION_DAYS must be a positive integer (got: ${process.env.PG_HISTORY_RETENTION_DAYS})`,
				)
			}

			const gracePeriod = Number.parseInt(
				process.env.PG_HISTORY_GRACE_PERIOD_DAYS || '7',
				10,
			)
			if (!Number.isFinite(gracePeriod) || gracePeriod < 1) {
				throw new Error(
					`PG_HISTORY_GRACE_PERIOD_DAYS must be a positive integer (got: ${process.env.PG_HISTORY_GRACE_PERIOD_DAYS})`,
				)
			}

			const batchSize = Number.parseInt(
				process.env.PG_HISTORY_BATCH_SIZE || '10000',
				10,
			)
			if (!Number.isFinite(batchSize) || batchSize < 1) {
				throw new Error(
					`PG_HISTORY_BATCH_SIZE must be a positive integer (got: ${process.env.PG_HISTORY_BATCH_SIZE})`,
				)
			}

			archiverConfig = {
				s3: {
					bucket: process.env.PG_HISTORY_S3_BUCKET,
					endpoint: process.env.PG_HISTORY_S3_ENDPOINT,
					region: process.env.PG_HISTORY_S3_REGION,
					accessKeyId: process.env.PG_HISTORY_S3_ACCESS_KEY_ID,
					secretAccessKey: process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY,
				},
				retention: { default: retentionDays },
				gracePeriod,
				batchSize,
			}
		}

		const { app, dispose } = await createServer({
			pool,
			serverless: true,
			enableHistory: true,
			historyConfig: { tables },
			enableArchiver: !!process.env.PG_HISTORY_S3_BUCKET,
			archiverConfig,
		})

		cachedApp = app

		// Register shutdown handlers only after the app is fully initialised.
		// Registering earlier risks calling pool.end() while setup DDL is still in
		// flight, which throws "Cannot use a pool after calling end on the pool".
		// Idempotency flag: SIGTERM + beforeExit can both fire on the same exit;
		// the second invocation must not call pool.end() again.
		let shuttingDown = false
		const onShutdown = () => {
			if (shuttingDown) return
			shuttingDown = true
			dispose().catch(() => {})
			pool.end().catch(() => {})
		}
		process.once('SIGTERM', onShutdown)
		process.once('beforeExit', onShutdown)

		return cachedApp
	})().catch((err) => {
		// Reset so the next request retries instead of returning the cached rejection
		initPromise = null
		throw err
	})

	return initPromise
}

// Vercel expects named exports per HTTP method
// Initialize on first request, then reuse cached app
function errorResponse(error: unknown): Response {
	// Log the real error server-side — never echo internal messages (connection
	// strings, env var names) back to the client.
	consoleLogger.error('Server initialization failed', { err: error })
	return new Response(
		JSON.stringify({
			error: { code: 'INIT_ERROR', message: 'Service initialization failed' },
		}),
		{ status: 500, headers: { 'Content-Type': 'application/json' } },
	)
}

export const GET = async (req: Request): Promise<Response> => {
	try {
		const app = await getApp()
		return handle(app)(req)
	} catch (error) {
		return errorResponse(error)
	}
}

export const POST = async (req: Request): Promise<Response> => {
	try {
		const app = await getApp()
		return handle(app)(req)
	} catch (error) {
		return errorResponse(error)
	}
}
