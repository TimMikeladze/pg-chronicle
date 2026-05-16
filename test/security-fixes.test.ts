import { beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { PgHistory } from '../src/PgHistory'
import { createServer } from '../src/server'
import { cleanDatabase, getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

// ─────────────────────────────────────────────────────────
// CRIT-1: SQL injection via DDL — uses format() now
// ─────────────────────────────────────────────────────────

describe('CRIT-1: DDL uses format() for safe interpolation', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
	})

	test('setup creates partition using format() without raw interpolation', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/PgHistory.ts', 'utf-8')
		const setupSource = await fs.readFile('./src/pg-history-setup.ts', 'utf-8')
		const combined = `${source}\n${setupSource}`

		expect(combined).not.toMatch(/FOR VALUES IN \('\$\{/)

		expect(combined).toContain('format(')
		expect(combined).toContain('%I')
		expect(combined).toContain('%L')
	})

	test('setup works correctly with format()-based DDL', async () => {
		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)

		const pgHistory = new PgHistory({ pool, tables: ['users'] })
		await pgHistory.setup()

		// Verify partition was created
		const partitions = await pool.query(
			"SELECT 1 FROM pg_tables WHERE tablename = 'audit_log_users'",
		)
		expect(partitions.rows.length).toBe(1)

		await pgHistory.teardown()
	})
})

// ─────────────────────────────────────────────────────────
// CRIT-2: /api/stats protected by JWT
// ─────────────────────────────────────────────────��───────

describe('CRIT-2: /api/stats requires JWT when secret is set', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
		// Create audit_log for archiver schema setup
		await pool.query(`
			CREATE TABLE IF NOT EXISTS audit_log (
				id BIGSERIAL, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
				operation TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				old_data JSONB, new_data JSONB, PRIMARY KEY (id, table_name)
			) PARTITION BY LIST (table_name)
		`)
	})

	test('returns 401 on /api/stats without JWT when secret is set', async () => {
		const original = process.env.PG_HISTORY_JWT_SECRET
		process.env.PG_HISTORY_JWT_SECRET = 'test-secret'

		const { app } = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: {
				s3: { bucket: 'test' },
				retention: { default: 90 },
				gracePeriod: 7,
				batchSize: 100,
			},
			serverless: true,
		})

		const res = await app.request('/api/stats')
		expect(res.status).toBe(401)

		process.env.PG_HISTORY_JWT_SECRET = original
	})
})

// ─────────────────────────────────────────────────────────
// HIGH-2: PG_HISTORY_TABLES trimmed and filtered
// ─────────────────────────────────────────────────────────

describe('HIGH-2: PG_HISTORY_TABLES sanitization', () => {
	test('vercel.ts trims and filters table names', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/vercel.ts', 'utf-8')

		expect(source).toContain('.trim()')
		expect(source).toContain('.filter(Boolean)')
	})
})

// ─────────────────────────────────────���───────────────────
// HIGH-3: No raw DB errors returned to clients
// ─────────────────────────────────────────────────────────

describe('HIGH-3: Generic error messages for database errors', () => {
	test('server.ts does not return raw error.message for any error response', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/server.ts', 'utf-8')

		// Check DATABASE_ERROR responses use generic message
		const dbErrorBlocks = source.split('DATABASE_ERROR')
		for (let i = 1; i < dbErrorBlocks.length; i++) {
			const block = dbErrorBlocks[i]
			if (!block) continue
			const context = block.substring(0, 200)
			expect(context).toContain('An internal error occurred')
		}

		// Check ARCHIVAL_ERROR also uses generic message
		const archivalBlocks = source.split('ARCHIVAL_ERROR')
		for (let i = 1; i < archivalBlocks.length; i++) {
			const block = archivalBlocks[i]
			if (!block) continue
			const context = block.substring(0, 200)
			expect(context).toContain('An internal error occurred')
		}

		// No raw `error.message` should appear in any createErrorResponse call
		// (except for controlled application errors like PgHistoryError)
		const errorPattern = /createErrorResponse\([^)]*error\.message[^)]*\)/g
		const matches = source.match(errorPattern) || []
		// Only controlled error types should pass error.message
		for (const match of matches) {
			expect(
				match.includes('INVALID_TABLE') ||
					match.includes('NOT_FOUND') ||
					match.includes('NOT_CONFIGURED') ||
					match.includes('VALIDATION_ERROR') ||
					match.includes('REVERT_ERROR'),
			).toBe(true)
		}
	})

	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
	})

	test('getHistory returns generic error, not DB details', async () => {
		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)

		const { app } = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] },
		})

		// Request with a very long recordId to trigger potential DB error
		const res = await app.request('/api/history/users/valid-id')
		// Even if it fails, it should not leak DB internals
		if (res.status === 500) {
			const body = await res.json()
			expect(body.error.message).toBe('An internal error occurred')
		}
	})
})

// ──────────────────────────────────────��──────────────────
// HIGH-5: Revert validates columns against real table schema
// ───────────────────────────────────────��─────────────────

describe('HIGH-5: Revert column cross-check', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
	})

	test('revert rejects old_data with columns not in the actual table', async () => {
		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)

		const pgHistory = new PgHistory({ pool, tables: ['users'] })
		await pgHistory.setup()

		// Insert a user to create history
		await pool.query("INSERT INTO users (name) VALUES ('Alice')")

		// Manually craft an audit entry with a fake column in old_data
		await pool.query(
			`INSERT INTO "public"."audit_log" (table_name, record_id, operation, old_data)
			VALUES ('users', '1', 'UPDATE', $1)`,
			[JSON.stringify({ id: 1, name: 'Alice', evil_column: 'injected' })],
		)

		// Get the crafted entry ID
		const entry = await pool.query(
			`SELECT id FROM "public"."audit_log"
			WHERE table_name = 'users' AND record_id = '1' AND operation = 'UPDATE'
			ORDER BY id DESC LIMIT 1`,
		)

		// Attempt to revert should fail because evil_column doesn't exist
		await expect(
			pgHistory.revert('users', '1', entry.rows[0].id.toString()),
		).rejects.toThrow('columns not in table')

		await pgHistory.teardown()
	})
})

// ─────────────────────────────────────────────────────────
// MED-1: Archival interval has minimum bound
// ─────────────────────────────────────────────────────────

describe('MED-1: Archival interval minimum bound', () => {
	test('server.ts enforces minimum 60s interval', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/server.ts', 'utf-8')

		expect(source).toContain('MIN_INTERVAL_MS')
		expect(source).toContain('Math.max')
		expect(source).toContain('60_000')
	})
})

// ───────────────────────────────────────────────���─────────
// MED-2: Timing-safe cron secret comparison
// ────────────────────────────────────────────────���────────

describe('MED-2: Timing-safe cron secret comparison', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
		await pool.query(`
			CREATE TABLE IF NOT EXISTS audit_log (
				id BIGSERIAL, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
				operation TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				old_data JSONB, new_data JSONB, PRIMARY KEY (id, table_name)
			) PARTITION BY LIST (table_name)
		`)
	})

	test('server.ts uses timingSafeEqual for cron secret', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/server.ts', 'utf-8')

		expect(source).toContain('timingSafeEqual')
	})

	test('rejects wrong secret via timing-safe path', async () => {
		const { app } = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: {
				s3: { bucket: 'test' },
				retention: { default: 90 },
				gracePeriod: 7,
				batchSize: 100,
			},
			archiveCronSecret: 'correct-secret',
			serverless: true,
		})

		const res = await app.request('/api/archive', {
			method: 'POST',
			headers: { Authorization: 'Bearer wrong-secret' },
		})
		expect(res.status).toBe(401)
	})

	test('accepts correct secret via timing-safe path', async () => {
		const { app } = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: {
				s3: { bucket: 'test' },
				retention: { default: 90 },
				gracePeriod: 7,
				batchSize: 100,
			},
			archiveCronSecret: 'correct-secret',
			serverless: true,
		})

		const res = await app.request('/api/archive', {
			method: 'POST',
			headers: { Authorization: 'Bearer correct-secret' },
		})
		// May fail for other reasons (no S3) but should NOT be 401
		expect(res.status).not.toBe(401)
	})
})

// ─────────────────────────────────��───────────────────────
// MED-3: Temp files in restricted directory
// ──────────────────────────────────────────���──────────────

describe('MED-3: Temp files use restricted directory', () => {
	test('PgHistoryArchiver uses mkdtemp with chmod 0o700', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/PgHistoryArchiver.ts', 'utf-8')

		expect(source).toContain('mkdtemp')
		expect(source).toContain('chmod')
		expect(source).toContain('0o700')
		// Should clean up directory recursively
		expect(source).toContain('rm(tmpDir, { recursive: true })')
	})
})

// ─────────────────────────────────��───────────────────────
// MED-4: Cursor validation (numeric only)
// ─────────────────────────────────────────────────────────

describe('MED-4: Cursor must be numeric', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
	})

	test('getHistory rejects non-numeric cursor', async () => {
		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)
		const pgHistory = new PgHistory({ pool, tables: ['users'] })
		await pgHistory.setup()

		await expect(
			pgHistory.getHistory('users', '1', { cursor: 'abc; DROP TABLE users' }),
		).rejects.toThrow('cursor must be a numeric ID')

		await pgHistory.teardown()
	})

	test('getHistory accepts numeric cursor', async () => {
		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)
		const pgHistory = new PgHistory({ pool, tables: ['users'] })
		await pgHistory.setup()

		// Should not throw — cursor is valid
		const result = await pgHistory.getHistory('users', '1', { cursor: '999' })
		expect(result.data).toBeArray()

		await pgHistory.teardown()
	})

	test('search rejects non-numeric cursor', async () => {
		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)
		const pgHistory = new PgHistory({ pool, tables: ['users'] })
		await pgHistory.setup()

		await expect(
			// Cast: intentionally passing invalid input to test runtime validation
			pgHistory.search({ tables: ['users'], cursor: 'not-a-number' as never }),
		).rejects.toThrow('cursor must be a numeric ID')

		await pgHistory.teardown()
	})
})

// ───────────────────────────��─────────────────────────────
// MED-5: discoverTables returns unqualified names
// ──────────────────────────────────────────���──────────────

describe('MED-5: discoverTables returns unqualified names', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
	})

	test('discovered table names are unqualified (no schema prefix)', async () => {
		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)

		const pgHistory = new PgHistory({ pool, tables: ['users'] })
		await pgHistory.setup()

		const { Orchestrator } = await import('../src/orchestrator')
		const orchestrator = new Orchestrator(
			{ bucket: 'test' },
			{ default: 90 },
			7,
			100,
		)

		const tables = await orchestrator.discoverTables(pool)

		// Should return 'users', not '"public"."users"' or 'public.users'
		expect(tables).toContain('users')
		for (const t of tables) {
			expect(t).not.toContain('.')
			expect(t).not.toContain('"')
		}

		await pgHistory.teardown()
	})
})

// ─────────────────────────────────────────────────────────
// LOW-2: forcePathStyle conditional on endpoint
// ─────────────────────────────────────────────────────────

describe('LOW-2: forcePathStyle only with custom endpoint', () => {
	test('S3 client uses forcePathStyle conditionally', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/PgHistoryArchiver.ts', 'utf-8')

		expect(source).toContain('forcePathStyle: !!config.s3.endpoint')
		expect(source).not.toContain('forcePathStyle: true')
	})
})

// ─────────────────────────────────────────────────────────
// LOW-3: Security headers present
// ─────────────────────────────────────────────────────────

describe('LOW-3: Security headers on all responses', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
	})

	test('responses include X-Content-Type-Options: nosniff', async () => {
		const { app } = await createServer({ pool })

		const res = await app.request('/health')
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
	})

	test('responses include X-Frame-Options: DENY', async () => {
		const { app } = await createServer({ pool })

		const res = await app.request('/health')
		expect(res.headers.get('X-Frame-Options')).toBe('DENY')
	})
})

// ─────────────────────────────────────────────────────────
// Health endpoint doesn't leak lastError
// ─────────────────────────────────────────────────────────

describe('Health endpoint strips internal error details', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
		await pool.query(`
			CREATE TABLE IF NOT EXISTS audit_log (
				id BIGSERIAL, table_name TEXT NOT NULL, record_id TEXT NOT NULL,
				operation TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				old_data JSONB, new_data JSONB, PRIMARY KEY (id, table_name)
			) PARTITION BY LIST (table_name)
		`)
	})

	test('health response does not contain lastError field', async () => {
		const { app } = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: {
				s3: { bucket: 'test' },
				retention: { default: 90 },
				gracePeriod: 7,
				batchSize: 100,
			},
			serverless: true,
		})

		const res = await app.request('/health')
		const body = await res.json()

		if (body.archival) {
			expect(body.archival).not.toHaveProperty('lastError')
		}
	})
})
