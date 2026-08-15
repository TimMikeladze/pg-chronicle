// `hono/vercel` is Hono's Next.js App Router adapter, despite the name.
import { handle } from 'hono/vercel'
import type { Pool } from 'pg'
import { consoleLogger } from './logger'
import { createServer } from './server'
import type { ServerConfig } from './types'

// Infer the Hono app type from createServer to avoid type casts
type App = Awaited<ReturnType<typeof createServer>>['app']

/**
 * Overrides for {@link createHandlers}. Everything not supplied is derived from
 * environment variables exactly as the default export does.
 *
 * The important one is `authorize`: authentication proves who the caller is,
 * this proves they may touch a given table/record. Without it any valid token
 * reaches every record of every configured table — there is no tenant
 * isolation. It cannot come from an env var, so a route file that needs it must
 * use `createHandlers`.
 */
export type NextServerOverrides = Partial<ServerConfig>

/** The three App Router method exports a route file re-exports. */
export interface NextRouteHandlers {
	GET: (req: Request) => Promise<Response>
	POST: (req: Request) => Promise<Response>
	OPTIONS: (req: Request) => Promise<Response>
}

/**
 * Derive the server config from the environment.
 *
 * `overrides` is consulted only to decide which env vars are *required*: a
 * caller who passes `historyConfig` in code has already answered the question
 * `PG_CHRONICLE_TABLES` exists to answer, and demanding the variable anyway would
 * make the whole point of `createHandlers` — configuring in code — impossible.
 */
function envConfig(
	overrides: NextServerOverrides,
): Omit<ServerConfig, 'pool'> & { pool?: Pool } {
	const tables =
		process.env.PG_CHRONICLE_TABLES?.split(',')
			.map((t) => t.trim())
			.filter(Boolean) || []
	if (tables.length === 0 && !overrides.historyConfig) {
		throw new Error(
			'PG_CHRONICLE_TABLES environment variable is required (comma-separated table names), ' +
				'or pass historyConfig to createHandlers()',
		)
	}

	let archiverConfig: ServerConfig['archiverConfig']
	if (process.env.PG_CHRONICLE_S3_BUCKET) {
		const retentionDays = Number.parseInt(
			process.env.PG_CHRONICLE_RETENTION_DAYS || '90',
			10,
		)
		if (!Number.isFinite(retentionDays) || retentionDays < 1) {
			throw new Error(
				`PG_CHRONICLE_RETENTION_DAYS must be a positive integer (got: ${process.env.PG_CHRONICLE_RETENTION_DAYS})`,
			)
		}

		const gracePeriod = Number.parseInt(
			process.env.PG_CHRONICLE_GRACE_PERIOD_DAYS || '7',
			10,
		)
		// gracePeriod may be 0 (no grace — purge once the S3 backup is confirmed).
		if (!Number.isFinite(gracePeriod) || gracePeriod < 0) {
			throw new Error(
				`PG_CHRONICLE_GRACE_PERIOD_DAYS must be an integer >= 0 (got: ${process.env.PG_CHRONICLE_GRACE_PERIOD_DAYS})`,
			)
		}

		const batchSize = Number.parseInt(
			process.env.PG_CHRONICLE_BATCH_SIZE || '10000',
			10,
		)
		if (!Number.isFinite(batchSize) || batchSize < 1) {
			throw new Error(
				`PG_CHRONICLE_BATCH_SIZE must be a positive integer (got: ${process.env.PG_CHRONICLE_BATCH_SIZE})`,
			)
		}

		const maxBatchBytes = process.env.PG_CHRONICLE_MAX_BATCH_BYTES
			? Number.parseInt(process.env.PG_CHRONICLE_MAX_BATCH_BYTES, 10)
			: undefined
		if (
			maxBatchBytes !== undefined &&
			(!Number.isFinite(maxBatchBytes) || maxBatchBytes < 1)
		) {
			throw new Error(
				`PG_CHRONICLE_MAX_BATCH_BYTES must be a positive integer (got: ${process.env.PG_CHRONICLE_MAX_BATCH_BYTES})`,
			)
		}

		const staleClaimMinutes = process.env.PG_CHRONICLE_STALE_CLAIM_MINUTES
			? Number.parseInt(process.env.PG_CHRONICLE_STALE_CLAIM_MINUTES, 10)
			: undefined
		if (
			staleClaimMinutes !== undefined &&
			(!Number.isFinite(staleClaimMinutes) || staleClaimMinutes < 1)
		) {
			throw new Error(
				`PG_CHRONICLE_STALE_CLAIM_MINUTES must be a positive integer (got: ${process.env.PG_CHRONICLE_STALE_CLAIM_MINUTES})`,
			)
		}

		archiverConfig = {
			s3: {
				bucket: process.env.PG_CHRONICLE_S3_BUCKET,
				endpoint: process.env.PG_CHRONICLE_S3_ENDPOINT,
				region: process.env.PG_CHRONICLE_S3_REGION,
				accessKeyId: process.env.PG_CHRONICLE_S3_ACCESS_KEY_ID,
				secretAccessKey: process.env.PG_CHRONICLE_S3_SECRET_ACCESS_KEY,
			},
			retention: { default: retentionDays },
			gracePeriod,
			batchSize,
			maxBatchBytes,
			staleClaimMinutes,
		}
	}

	return {
		serverless: true,
		enableHistory: true,
		historyConfig: { tables },
		enableArchiver: !!process.env.PG_CHRONICLE_S3_BUCKET,
		archiverConfig,
	}
}

function envPool(): Pool | Promise<Pool> {
	const databaseUrl = process.env.PG_CHRONICLE_DATABASE_URL
	if (!databaseUrl) {
		throw new Error(
			'PG_CHRONICLE_DATABASE_URL environment variable is required',
		)
	}

	const poolMax = Number.parseInt(process.env.PG_CHRONICLE_POOL_MAX || '3', 10)
	if (!Number.isFinite(poolMax) || poolMax < 1) {
		throw new Error(
			`PG_CHRONICLE_POOL_MAX must be a positive integer (got: ${process.env.PG_CHRONICLE_POOL_MAX})`,
		)
	}
	// Bound every pool query so a stuck connection can't wedge a warm
	// serverless instance. See main.ts for PG_CHRONICLE_STATEMENT_TIMEOUT_MS.
	const statementTimeoutMs = Number.parseInt(
		process.env.PG_CHRONICLE_STATEMENT_TIMEOUT_MS || '30000',
		10,
	)
	return import('pg').then(
		(pg) =>
			new pg.default.Pool({
				connectionString: databaseUrl,
				max: poolMax,
				connectionTimeoutMillis: 10_000,
				idleTimeoutMillis: 30_000,
				statement_timeout: Number.isFinite(statementTimeoutMs)
					? statementTimeoutMs
					: 30_000,
				idle_in_transaction_session_timeout: 60_000,
			}),
	)
}

/**
 * Build App Router handlers for the pg-chronicle REST API.
 *
 * Call this instead of re-exporting the default `GET`/`POST` when you need
 * anything that cannot be expressed as an environment variable — above all an
 * `authorize` hook, but also `cors`, `clientIdentifier`, or your own pool:
 *
 * ```ts
 * // app/api/[[...route]]/route.ts
 * import { createHandlers } from 'pg-chronicle/next'
 *
 * export const { GET, POST, OPTIONS } = createHandlers({
 *   authorize: async ({ actor, table, recordId }) =>
 *     Boolean(actor) && (await userMayRead(actor, table, recordId)),
 * })
 * export const dynamic = 'force-dynamic'
 * ```
 *
 * Each call gets its own lazily-initialised app and connection pool, cached for
 * the life of the module (so warm invocations reuse it).
 */
export function createHandlers(
	overrides: NextServerOverrides = {},
): NextRouteHandlers {
	let cachedApp: App | null = null
	let initPromise: Promise<App> | null = null

	function getApp(): Promise<App> {
		if (cachedApp) return Promise.resolve(cachedApp)
		if (initPromise) return initPromise

		initPromise = (async () => {
			// A caller-supplied pool belongs to the caller: we neither create nor
			// close it, and the shutdown hook below skips it.
			const suppliedPool = overrides.pool
			const pool = suppliedPool ?? (await envPool())

			const { app, dispose } = await createServer({
				...envConfig(overrides),
				...overrides,
				pool,
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
				if (!suppliedPool) pool.end().catch(() => {})
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

	const dispatch = async (req: Request): Promise<Response> => {
		try {
			const app = await getApp()
			return handle(app)(req)
		} catch (error) {
			return errorResponse(error)
		}
	}

	return {
		GET: dispatch,
		POST: dispatch,
		// Without an OPTIONS export Next answers preflight with 405 and the
		// browser blocks the real cross-origin request, no matter what `cors`
		// is set to.
		OPTIONS: dispatch,
	}
}

// Next.js App Router expects named exports per HTTP method
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

// Default, fully env-driven handlers. Re-export these from a route file when no
// code-level configuration is needed.
const defaultHandlers = createHandlers()

// Explicitly annotated: the .d.ts is generated with isolated declarations, which
// cannot infer a type through a property access and would emit `unknown`.
export const GET: NextRouteHandlers['GET'] = defaultHandlers.GET
export const POST: NextRouteHandlers['POST'] = defaultHandlers.POST
export const OPTIONS: NextRouteHandlers['OPTIONS'] = defaultHandlers.OPTIONS
