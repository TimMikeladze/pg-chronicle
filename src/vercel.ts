import type { Hono } from 'hono'
import { handle } from 'hono/vercel'
import { createServer } from './server'

// Module-level cache — survives across warm invocations
let cachedApp: Hono | null = null
let initPromise: Promise<Hono> | null = null

function getApp(): Promise<Hono> {
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
		const pool = new pg.default.Pool({
			connectionString: databaseUrl,
			max: poolMax,
		})

		const tables = process.env.PG_HISTORY_TABLES?.split(',') || []
		if (tables.length === 0) {
			throw new Error(
				'PG_HISTORY_TABLES environment variable is required (comma-separated table names)',
			)
		}

		const app = await createServer({
			pool,
			serverless: true,
			enableHistory: true,
			historyConfig: { tables },
			enableArchiver: !!process.env.PG_HISTORY_S3_BUCKET,
			archiverConfig: process.env.PG_HISTORY_S3_BUCKET
				? {
						s3: {
							bucket: process.env.PG_HISTORY_S3_BUCKET,
							endpoint: process.env.PG_HISTORY_S3_ENDPOINT,
							region: process.env.PG_HISTORY_S3_REGION,
							accessKeyId: process.env.PG_HISTORY_S3_ACCESS_KEY_ID,
							secretAccessKey: process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY,
						},
						retention: {
							default: Number.parseInt(
								process.env.PG_HISTORY_RETENTION_DAYS || '90',
								10,
							),
						},
						gracePeriod: Number.parseInt(
							process.env.PG_HISTORY_GRACE_PERIOD_DAYS || '7',
							10,
						),
						batchSize: Number.parseInt(
							process.env.PG_HISTORY_BATCH_SIZE || '10000',
							10,
						),
					}
				: undefined,
		})

		cachedApp = app as unknown as Hono
		return cachedApp
	})()

	return initPromise
}

// Vercel expects named exports per HTTP method
// Initialize on first request, then reuse cached app
export const GET = async (req: Request): Promise<Response> => {
	const app = await getApp()
	return handle(app)(req)
}

export const POST = async (req: Request): Promise<Response> => {
	const app = await getApp()
	return handle(app)(req)
}
