import { beforeEach, describe, expect, test } from 'bun:test'
import { PgHistory } from '../src/PgHistory'
import { createServer } from '../src/server'
import { cleanDatabase, getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('excludeColumns config', () => {
	beforeEach(async () => {
		await cleanDatabase()
	})

	test('strips listed columns from audit payload', async () => {
		const pool = await getTestConnection()
		await pool.query(`
			CREATE TABLE users (
				id SERIAL PRIMARY KEY,
				name TEXT,
				password_hash TEXT,
				email TEXT
			)
		`)

		const history = new PgHistory({
			tables: ['users'],
			excludeColumns: { users: ['password_hash'] },
			pool,
		})
		await history.setup()

		await pool.query(
			`INSERT INTO users (name, password_hash, email) VALUES ($1, $2, $3)`,
			['alice', 'secret-hash', 'alice@example.com'],
		)

		const result = await pool.query(
			`SELECT new_data FROM audit_log WHERE table_name = 'users' LIMIT 1`,
		)
		const newData = result.rows[0].new_data as Record<string, unknown>
		expect(newData.name).toBe('alice')
		expect(newData.email).toBe('alice@example.com')
		expect(newData.password_hash).toBeUndefined()

		await history.teardown()
	})

	test('rejects unknown table in excludeColumns', () => {
		const pool = new (require('pg').Pool)()
		expect(
			() =>
				new PgHistory({
					tables: ['users'],
					excludeColumns: { posts: ['secret'] },
					pool,
				}),
		).toThrow(/unknown table/)
		pool.end()
	})

	test('rejects PK columns in excludeColumns at trigger setup time', async () => {
		const pool = await getTestConnection()
		await pool.query(`
			CREATE TABLE users (
				id SERIAL PRIMARY KEY,
				name TEXT
			)
		`)

		const history = new PgHistory({
			tables: ['users'],
			excludeColumns: { users: ['id'] },
			pool,
		})

		expect(history.setup()).rejects.toThrow(/PK columns/)
		await pool.query(`DROP TABLE users CASCADE`)
	})
})

describe('idempotent UPDATE skip', () => {
	beforeEach(async () => {
		await cleanDatabase()
	})

	test('no audit row created when UPDATE leaves all columns unchanged', async () => {
		const pool = await getTestConnection()
		await pool.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)`)

		const history = new PgHistory({ tables: ['users'], pool })
		await history.setup()

		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'alice')`)
		await pool.query(`UPDATE users SET name = name WHERE id = 1`)
		await pool.query(`UPDATE users SET name = name WHERE id = 1`)

		const result = await pool.query(
			`SELECT operation FROM audit_log WHERE table_name = 'users' ORDER BY id`,
		)
		expect(result.rows.length).toBe(1)
		expect(result.rows[0].operation).toBe('INSERT')

		await history.teardown()
	})
})

describe('archivalRetry config validation', () => {
	test('rejects maxAttempts < 1', async () => {
		const pool = await getTestConnection()
		await expect(
			createServer({
				pool,
				enableArchiver: true,
				archiverConfig: {
					s3: { bucket: 'test' },
					retention: { default: 90 },
					gracePeriod: 7,
				},
				archivalRetry: { maxAttempts: 0 },
				serverless: true,
			}),
		).rejects.toThrow(/maxAttempts/)
	})

	test('rejects delays array shorter than maxAttempts - 1', async () => {
		const pool = await getTestConnection()
		await expect(
			createServer({
				pool,
				enableArchiver: true,
				archiverConfig: {
					s3: { bucket: 'test' },
					retention: { default: 90 },
					gracePeriod: 7,
				},
				archivalRetry: { maxAttempts: 4, delays: [1000, 2000] },
				serverless: true,
			}),
		).rejects.toThrow(/delays must have at least/)
	})
})

describe('JWT alg env validation', () => {
	test('rejects unsupported algorithm', async () => {
		const pool = await getTestConnection()
		process.env.PG_HISTORY_JWT_SECRET = 'test-secret'
		process.env.PG_HISTORY_JWT_ALG = 'NONE'
		try {
			await expect(
				createServer({
					pool,
					enableHistory: true,
					allowUnauthenticated: true,
					historyConfig: { tables: ['users'] },
				}),
			).rejects.toThrow(/not supported/)
		} finally {
			delete process.env.PG_HISTORY_JWT_SECRET
			delete process.env.PG_HISTORY_JWT_ALG
		}
	})

	test('accepts RS256', async () => {
		const pool = await getTestConnection()
		await cleanDatabase()
		await pool.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)`)
		process.env.PG_HISTORY_JWT_SECRET = 'test-public-key'
		process.env.PG_HISTORY_JWT_ALG = 'RS256'
		try {
			const { app } = await createServer({
				pool,
				enableHistory: true,
				allowUnauthenticated: true,
				historyConfig: { tables: ['users'] },
			})
			expect(app).toBeDefined()
		} finally {
			delete process.env.PG_HISTORY_JWT_SECRET
			delete process.env.PG_HISTORY_JWT_ALG
		}
	})
})

describe('/api/health/detailed', () => {
	beforeEach(async () => {
		await cleanDatabase()
	})

	test('returns 401 without cron secret in cron-only deployment', async () => {
		const pool = await getTestConnection()
		await pool.query(`
			CREATE TABLE IF NOT EXISTS audit_log (
				id BIGSERIAL,
				table_name TEXT NOT NULL,
				record_id TEXT NOT NULL,
				operation TEXT NOT NULL,
				changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				old_data JSONB,
				new_data JSONB,
				PRIMARY KEY (id, table_name)
			) PARTITION BY LIST (table_name)
		`)

		const { app } = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: {
				s3: { bucket: 'test' },
				retention: { default: 90 },
				gracePeriod: 7,
			},
			archiveCronSecret: 'my-secret',
			serverless: true,
		})

		const res = await app.request('/api/health/detailed')
		expect(res.status).toBe(401)
	})

	test('returns archival state with valid cron secret', async () => {
		const pool = await getTestConnection()
		await pool.query(`
			CREATE TABLE IF NOT EXISTS audit_log (
				id BIGSERIAL,
				table_name TEXT NOT NULL,
				record_id TEXT NOT NULL,
				operation TEXT NOT NULL,
				changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				old_data JSONB,
				new_data JSONB,
				PRIMARY KEY (id, table_name)
			) PARTITION BY LIST (table_name)
		`)

		const { app } = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: {
				s3: { bucket: 'test' },
				retention: { default: 90 },
				gracePeriod: 7,
			},
			archiveCronSecret: 'my-secret',
			serverless: true,
		})

		const res = await app.request('/api/health/detailed', {
			headers: { authorization: 'Bearer my-secret' },
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { archival: { lastError: unknown } }
		expect(body.archival).toBeDefined()
		expect('lastError' in body.archival).toBe(true)
	})

	test('public /health is minimal', async () => {
		const pool = await getTestConnection()
		await pool.query(`
			CREATE TABLE IF NOT EXISTS audit_log (
				id BIGSERIAL,
				table_name TEXT NOT NULL,
				record_id TEXT NOT NULL,
				operation TEXT NOT NULL,
				changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				old_data JSONB,
				new_data JSONB,
				PRIMARY KEY (id, table_name)
			) PARTITION BY LIST (table_name)
		`)
		const { app } = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: {
				s3: { bucket: 'test' },
				retention: { default: 90 },
				gracePeriod: 7,
			},
			archiveCronSecret: 'my-secret',
			serverless: true,
		})

		const res = await app.request('/health')
		expect(res.status).toBe(200)
		const body = (await res.json()) as Record<string, unknown>
		expect(body.status).toBe('ok')
		expect(body.archival).toBeUndefined()
		expect(body.lastError).toBeUndefined()
	})
})

describe('CORS preflight bypasses JWT', () => {
	test('OPTIONS to /api/* returns 2xx with CORS configured even without auth', async () => {
		const pool = await getTestConnection()
		await cleanDatabase()
		await pool.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)`)

		process.env.PG_HISTORY_JWT_SECRET = 'preflight-secret'
		try {
			const { app } = await createServer({
				pool,
				enableHistory: true,
				allowUnauthenticated: true,
				historyConfig: { tables: ['users'] },
				cors: { origin: 'https://app.example.com' },
			})

			const res = await app.request('/api/history/users/1', {
				method: 'OPTIONS',
				headers: {
					origin: 'https://app.example.com',
					'access-control-request-method': 'GET',
				},
			})
			expect(res.status).toBeLessThan(300)
		} finally {
			delete process.env.PG_HISTORY_JWT_SECRET
		}
	})
})
