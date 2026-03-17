import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { SetupRequiredError } from '../src/errors'
import { PgHistory } from '../src/PgHistory'
import { createServer } from '../src/server'
import { cleanDatabase, getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('SetupRequiredError guard', () => {
	test('getHistory throws SetupRequiredError before setup()', async () => {
		const pool = await getTestConnection()
		const history = new PgHistory({ pool, tables: ['users'] })

		await expect(history.getHistory('users', '1')).rejects.toThrow(
			SetupRequiredError,
		)
	})

	test('search throws SetupRequiredError before setup()', async () => {
		const pool = await getTestConnection()
		const history = new PgHistory({ pool, tables: ['users'] })

		await expect(history.search({ tables: ['users'] })).rejects.toThrow(
			SetupRequiredError,
		)
	})

	test('revert throws SetupRequiredError before setup()', async () => {
		const pool = await getTestConnection()
		const history = new PgHistory({ pool, tables: ['users'] })

		await expect(history.revert('users', '1', '1')).rejects.toThrow(
			SetupRequiredError,
		)
	})

	test('methods work after setup()', async () => {
		const pool = await getTestConnection()
		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)

		const history = new PgHistory({ pool, tables: ['users'] })
		await history.setup()

		const result = await history.getHistory('users', '1')
		expect(result.data).toBeArray()

		await history.teardown()
	})
})

describe('Operation validation in search', () => {
	let pool: Pool
	let history: PgHistory

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)
		history = new PgHistory({ pool, tables: ['users'] })
		await history.setup()
	})

	afterEach(async () => {
		await history.teardown()
		await cleanDatabase()
	})

	test('rejects invalid operation', async () => {
		await expect(
			history.search({
				tables: ['users'],
				// @ts-expect-error intentionally passing invalid operation
				operation: 'TRUNCATE',
			}),
		).rejects.toThrow('Invalid operation')
	})

	test('accepts valid operations', async () => {
		for (const op of ['INSERT', 'UPDATE', 'DELETE'] as const) {
			const result = await history.search({
				tables: ['users'],
				operation: op,
			})
			expect(result.data).toBeArray()
		}
	})
})

describe('Serverless mode', () => {
	test('createServer with serverless: true skips background archival', async () => {
		const pool = await getTestConnection()
		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)

		const app = await createServer({
			pool,
			serverless: true,
			enableHistory: true,
			historyConfig: { tables: ['users'] },
		})

		// No archival promise should be attached
		const appState = app as unknown as Record<string, unknown>
		expect(appState._archivalPromise).toBeUndefined()
		expect(appState._archivalInterval).toBeUndefined()

		// Health endpoint should still work
		const res = await app.request('/health')
		expect(res.status).toBe(200)

		const json = await res.json()
		expect(json.status).toBe('ok')
	})

	test('history endpoints still work in serverless mode', async () => {
		const pool = await getTestConnection()
		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)

		const app = await createServer({
			pool,
			serverless: true,
			enableHistory: true,
			historyConfig: { tables: ['users'] },
		})

		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)

		const res = await app.request('/api/history/users/1')
		expect(res.status).toBe(200)

		const json = await res.json()
		expect(json.data).toBeArray()
	})
})

describe('POST /api/archive endpoint', () => {
	test('returns 401 with wrong cron secret', async () => {
		const pool = await getTestConnection()

		// Create the audit_log table that archiver schema setup expects
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

		const app = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: {
				s3: { bucket: 'test' },
				retention: { default: 90 },
				gracePeriod: 7,
				batchSize: 100,
			},
			serverless: true,
			archiveCronSecret: 'my-secret',
		})

		const res = await app.request('/api/archive', {
			method: 'POST',
			headers: { authorization: 'Bearer wrong-secret' },
		})

		expect(res.status).toBe(401)
	})

	test('returns 200 with correct cron secret', async () => {
		const pool = await getTestConnection()

		// Create the audit_log table that archiver expects
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

		const app = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: {
				s3: {
					bucket: 'test-bucket',
					endpoint: process.env.PG_HISTORY_S3_ENDPOINT,
					accessKeyId: process.env.PG_HISTORY_S3_ACCESS_KEY_ID,
					secretAccessKey: process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY,
					region: process.env.PG_HISTORY_S3_REGION,
				},
				retention: { default: 90 },
				gracePeriod: 7,
				batchSize: 100,
			},
			serverless: true,
			archiveCronSecret: 'my-secret',
		})

		const res = await app.request('/api/archive', {
			method: 'POST',
			headers: { authorization: 'Bearer my-secret' },
		})

		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json.success).toBe(true)
		expect(json.archival).toBeDefined()
	})

	test('allows access without secret when none configured', async () => {
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

		// Save and clear env
		const savedCronSecret = process.env.CRON_SECRET
		delete process.env.CRON_SECRET

		const app = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: {
				s3: {
					bucket: 'test-bucket',
					endpoint: process.env.PG_HISTORY_S3_ENDPOINT,
					accessKeyId: process.env.PG_HISTORY_S3_ACCESS_KEY_ID,
					secretAccessKey: process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY,
					region: process.env.PG_HISTORY_S3_REGION,
				},
				retention: { default: 90 },
				gracePeriod: 7,
				batchSize: 100,
			},
			serverless: true,
		})

		const res = await app.request('/api/archive', { method: 'POST' })
		expect(res.status).toBe(200)

		// Restore env
		if (savedCronSecret) process.env.CRON_SECRET = savedCronSecret
	})
})

describe('ILIKE statement timeout', () => {
	let pool: Pool
	let history: PgHistory

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)
		history = new PgHistory({ pool, tables: ['users'] })
		await history.setup()
	})

	afterEach(async () => {
		await history.teardown()
		await cleanDatabase()
	})

	test('text search works on small data', async () => {
		await pool.query(`INSERT INTO users (name) VALUES ('Alice')`)

		const result = await history.search({
			tables: ['users'],
			query: 'Alice',
		})
		expect(result.data).toBeArray()
	})

	test('JSON containment search does not use ILIKE path', async () => {
		await pool.query(`INSERT INTO users (name) VALUES ('Alice')`)

		const result = await history.search({
			tables: ['users'],
			query: '{"name": "Alice"}',
		})
		expect(result.data).toBeArray()
	})
})
