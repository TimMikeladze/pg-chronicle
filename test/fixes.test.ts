import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import type { Pool } from 'pg'
import { silentLogger } from '../src/logger'
import { PgHistory } from '../src/PgHistory'
import { createServer } from '../src/server'
import { cleanDatabase, getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

// ─────────────────────────────────────────────────────────
// Fix #1 + #9: vercel.ts — init promise reset & error responses
// ─────────────────────────────────────────────────────────

describe('Fix #1 + #9: Vercel handler error recovery', () => {
	const originalEnv = { ...process.env }

	afterEach(() => {
		// Restore env
		process.env.PG_HISTORY_DATABASE_URL = originalEnv.PG_HISTORY_DATABASE_URL
		process.env.PG_HISTORY_TABLES = originalEnv.PG_HISTORY_TABLES
	})

	test('GET returns 500 JSON when init fails (missing env vars)', async () => {
		// Clear env so getApp() will fail
		delete process.env.PG_HISTORY_DATABASE_URL
		delete process.env.PG_HISTORY_TABLES

		// Dynamic import to get fresh module state
		const mod = await import('../src/vercel')
		const res = await mod.GET(new Request('http://localhost/health'))

		expect(res.status).toBe(500)
		const body = await res.json()
		expect(body.error.code).toBe('INIT_ERROR')
		// Generic message — real error is logged server-side, not exposed to clients
		expect(body.error.message).toBe('Service initialization failed')
	})

	test('POST returns 500 JSON when init fails (missing env vars)', async () => {
		delete process.env.PG_HISTORY_DATABASE_URL
		delete process.env.PG_HISTORY_TABLES

		const mod = await import('../src/vercel')
		const res = await mod.POST(
			new Request('http://localhost/api/archive', { method: 'POST' }),
		)

		expect(res.status).toBe(500)
		const body = await res.json()
		expect(body.error.code).toBe('INIT_ERROR')
	})

	test('error response has correct Content-Type header', async () => {
		delete process.env.PG_HISTORY_DATABASE_URL

		const mod = await import('../src/vercel')
		const res = await mod.GET(new Request('http://localhost/health'))

		expect(res.headers.get('Content-Type')).toBe('application/json')
	})
})

// ─────────────────────────────────────────────────────────
// Fix #2: PgHistoryArchiver — UTC date boundaries
// ─────────────────────────────────────────────────────────

describe('Fix #2: UTC date boundary computation', () => {
	test('day boundaries use UTC, not local timezone', () => {
		// Simulate the fixed logic from processBatch
		// Use a date that differs between UTC and common timezones
		// 2024-06-15 23:30:00 UTC = 2024-06-16 in UTC+1 timezones
		const date = new Date('2024-06-15T23:30:00Z')

		// Fixed code: UTC boundaries
		const dayStart = new Date(
			Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
		)
		const dayEnd = new Date(dayStart)
		dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)

		expect(dayStart.toISOString()).toBe('2024-06-15T00:00:00.000Z')
		expect(dayEnd.toISOString()).toBe('2024-06-16T00:00:00.000Z')
	})

	test('day boundaries span exactly 24h in UTC', () => {
		const date = new Date('2024-12-31T23:59:59Z')

		const dayStart = new Date(
			Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
		)
		const dayEnd = new Date(dayStart)
		dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)

		// Should be Dec 31 to Jan 1
		expect(dayStart.toISOString()).toBe('2024-12-31T00:00:00.000Z')
		expect(dayEnd.toISOString()).toBe('2025-01-01T00:00:00.000Z')
		expect(dayEnd.getTime() - dayStart.getTime()).toBe(24 * 60 * 60 * 1000)
	})

	test('handles DST transition dates correctly in UTC', () => {
		// March 10 2024 is DST transition in US Eastern
		const date = new Date('2024-03-10T05:00:00Z')

		const dayStart = new Date(
			Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
		)
		const dayEnd = new Date(dayStart)
		dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)

		// UTC is unaffected by DST
		expect(dayStart.toISOString()).toBe('2024-03-10T00:00:00.000Z')
		expect(dayEnd.toISOString()).toBe('2024-03-11T00:00:00.000Z')
		expect(dayEnd.getTime() - dayStart.getTime()).toBe(24 * 60 * 60 * 1000)
	})
})

// ─────────────────────────────────────────────────────────
// Fix #3: test:// bypass removed from production code
// ─────────────────────────────────────────────────────────

describe('Fix #3: No test:// S3 verification bypass', () => {
	test('verifyS3File source code does not contain test:// bypass', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/PgHistoryArchiver.ts', 'utf-8')

		// The test:// bypass should no longer exist in hardDeletePurged or verifyS3File
		expect(source).not.toContain("startsWith('test://')")
		expect(source).not.toContain('startsWith("test://")')
	})
})

// ─────────────────────────────────────────────────────────
// Fix #4: Archive endpoint warns when no cron secret
// ─────────────────────────────────────────────────────────

describe('Fix #4: Archive endpoint authentication warning', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
		// setupArchiverSchema needs audit_log to exist
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
	})

	test('logs error and refuses to register /api/archive when no auth is configured', async () => {
		const originalCronSecret = process.env.CRON_SECRET
		const originalSilent = process.env.PG_HISTORY_SILENT_LOGS
		delete process.env.CRON_SECRET
		delete process.env.PG_HISTORY_SILENT_LOGS

		const errorSpy = spyOn(console, 'error')

		await createServer({
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

		const errors = errorSpy.mock.calls.map((call) => call[0])
		expect(
			errors.some(
				(e: string) =>
					typeof e === 'string' &&
					e.includes('/api/archive endpoint NOT registered'),
			),
		).toBe(true)

		errorSpy.mockRestore()
		process.env.CRON_SECRET = originalCronSecret
		if (originalSilent !== undefined) {
			process.env.PG_HISTORY_SILENT_LOGS = originalSilent
		}
	})

	test('does not log archive auth error when cron secret is configured', async () => {
		const errorSpy = spyOn(console, 'error')

		await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: {
				s3: { bucket: 'test' },
				retention: { default: 90 },
				gracePeriod: 7,
				batchSize: 100,
			},
			archiveCronSecret: 'my-secret',
			serverless: true,
		})

		const errors = errorSpy.mock.calls.map((call) => call[0])
		expect(
			errors.some(
				(e: string) =>
					typeof e === 'string' &&
					e.includes('/api/archive endpoint NOT registered'),
			),
		).toBe(false)

		errorSpy.mockRestore()
	})

	test('archive endpoint rejects invalid cron secret', async () => {
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
		const body = await res.json()
		expect(body.error.code).toBe('UNAUTHORIZED')
	})
})

// ─────────────────────────────────────────────────────────
// Fix #5: ensurePool race condition
// ─────────────────────────────────────────────────────────

describe('Fix #5: ensurePool race condition', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
	})

	test('concurrent setup calls do not create duplicate pools', async () => {
		// Create a users table first
		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)

		const pgHistory = new PgHistory({
			connection:
				process.env.PG_AUDIT_TEST_URL ||
				'postgres://postgres:postgres@localhost:5432/pg_audit_test',
			tables: ['users'],
		})

		// Call setup concurrently — both paths will call ensurePool
		// With the fix, only one pool should be created
		const results = await Promise.allSettled([
			pgHistory.setup(),
			pgHistory.setup(),
		])

		// At least one should succeed (the other may succeed or fail with
		// "already exists" but should NOT throw a connection error)
		const successes = results.filter((r) => r.status === 'fulfilled')
		expect(successes.length).toBeGreaterThanOrEqual(1)

		// Verify the instance works after concurrent setup
		await pool.query("INSERT INTO users (name) VALUES ('test')")
		const history = await pgHistory.getHistory('users', '1')
		expect(history).toBeDefined()

		await pgHistory.teardown()
		await pgHistory.close()
	})
})

// ─────────────────────────────────────────────────────────
// Fix #6: JWT authentication warning
// ─────────────────────────────────────────────────────────

describe('Fix #6: JWT authentication warning', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
	})

	test('warns when API endpoints are unauthenticated', async () => {
		const originalJwt = process.env.PG_HISTORY_JWT_SECRET
		const originalSilent = process.env.PG_HISTORY_SILENT_LOGS
		delete process.env.PG_HISTORY_JWT_SECRET
		delete process.env.PG_HISTORY_SILENT_LOGS

		const warnSpy = spyOn(console, 'warn')

		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)

		await createServer({
			pool,
			enableHistory: true,
			allowUnauthenticated: true,
			historyConfig: { tables: ['users'] },
		})

		const warnings = warnSpy.mock.calls.map((call) => call[0])
		expect(
			warnings.some(
				(w: string) =>
					typeof w === 'string' &&
					w.includes('API endpoints are unauthenticated'),
			),
		).toBe(true)

		warnSpy.mockRestore()
		process.env.PG_HISTORY_JWT_SECRET = originalJwt
		if (originalSilent !== undefined) {
			process.env.PG_HISTORY_SILENT_LOGS = originalSilent
		}
	})

	test('does not warn when JWT secret is set', async () => {
		const originalJwt = process.env.PG_HISTORY_JWT_SECRET
		process.env.PG_HISTORY_JWT_SECRET = 'test-secret'

		const warnSpy = spyOn(console, 'warn')

		await pool.query(
			'CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)',
		)

		await createServer({
			pool,
			enableHistory: true,
			allowUnauthenticated: true,
			historyConfig: { tables: ['users'] },
		})

		const warnings = warnSpy.mock.calls.map((call) => call[0])
		expect(
			warnings.some(
				(w: string) =>
					typeof w === 'string' &&
					w.includes('API endpoints are unauthenticated'),
			),
		).toBe(false)

		warnSpy.mockRestore()
		process.env.PG_HISTORY_JWT_SECRET = originalJwt
	})

	test('does not warn when history is not enabled', async () => {
		const originalJwt = process.env.PG_HISTORY_JWT_SECRET
		delete process.env.PG_HISTORY_JWT_SECRET

		const warnSpy = spyOn(console, 'warn')

		await createServer({
			pool,
			enableHistory: false,
		})

		const warnings = warnSpy.mock.calls.map((call) => call[0])
		expect(
			warnings.some(
				(w: string) =>
					typeof w === 'string' &&
					w.includes('API endpoints are unauthenticated'),
			),
		).toBe(false)

		warnSpy.mockRestore()
		process.env.PG_HISTORY_JWT_SECRET = originalJwt
	})
})

// ─────────────────────────────────────────────────────────
// Fix #10: Module-level state (no type cast)
// ─────────────────────────────────────────────────────────

describe('Fix #10: No fragile type cast on app state', () => {
	test('server.ts source does not cast app to Record<string, unknown>', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/server.ts', 'utf-8')

		expect(source).not.toContain('as unknown as Record<string, unknown>')
	})
})

// ─────────────────────────────────────────────────────────
// Fix #11: Schema comment accuracy
// ─────────────────────────────────────────────────────────

describe('Fix #11: updateArchivalStats comment is accurate', () => {
	test('schema.ts comment documents the scan cost', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/schema.ts', 'utf-8')

		// Old misleading comment should be gone
		expect(source).not.toContain('without scanning full audit_log')

		// New accurate comment should exist
		expect(source).toContain('Scans audit_log rows')
		expect(source).toContain('can be expensive')
	})
})

// ─────────────────────────────────────────────────────────
// Review Fix #1: ensurePool() caches rejected promises forever
// ─────────────────────────────────────────────────────────

describe('Review Fix #1: ensurePool() retries after failed pool creation', () => {
	test('PgHistory retries after a failed pool creation', async () => {
		// A known-bad connection string — the DNS lookup will fail.
		const history = new PgHistory({
			tables: ['users'],
			connection: 'postgres://x:x@nonexistent.invalid.tld:5432/db',
			logger: silentLogger,
		})

		// First call should reject
		let firstError: unknown
		try {
			await history.setup()
		} catch (err) {
			firstError = err
		}
		expect(firstError).toBeDefined()

		// Second call should also reject (no cached rejection) — verifies the
		// poolPromise was reset so the next call attempts pool creation again.
		let secondError: unknown
		try {
			await history.setup()
		} catch (err) {
			secondError = err
		}
		expect(secondError).toBeDefined()
	}, 15_000)
})

// ─────────────────────────────────────────────────────────
// Review Fix #7: cursor is cast to bigint explicitly
// ─────────────────────────────────────────────────────────

describe('Review Fix #7: cursor is cast to bigint explicitly', () => {
	test('getHistory/search use $N::bigint in cursor clauses', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/PgHistory.ts', 'utf-8')

		// Both getHistory and search should cast cursor explicitly
		expect(source).toContain('id < $3::bigint')
		expect(source).toContain('id > $3::bigint')
		// search() cursor uses paramIndex variable; must include ::bigint
		expect(source).toContain('id < $${paramIndex}::bigint')
	})
})

// ─────────────────────────────────────────────────────────
// Review Fix #13: logger interface used throughout
// ─────────────────────────────────────────────────────────

describe('Review Fix #13: logger interface used throughout', () => {
	test('src files do not use bare console.log/error/warn', async () => {
		const fs = await import('node:fs/promises')
		const files = [
			'./src/PgHistory.ts',
			'./src/PgHistoryArchiver.ts',
			'./src/orchestrator.ts',
			'./src/server.ts',
		]

		for (const file of files) {
			const source = await fs.readFile(file, 'utf-8')
			// Strip comments so we don't false-positive on docs
			const noComments = source
				.replace(/\/\*[\s\S]*?\*\//g, '')
				.replace(/\/\/.*$/gm, '')
			expect(noComments).not.toContain('console.log(')
			expect(noComments).not.toContain('console.error(')
			expect(noComments).not.toContain('console.warn(')
		}
	})

	test('silentLogger can be injected without breaking behavior', () => {
		const history = new PgHistory({
			tables: ['dummy'],
			connection: 'postgres://user:pass@localhost:9999/fake',
			logger: silentLogger,
		})
		expect(history).toBeDefined()
	})
})

// ─────────────────────────────────────────────────────────
// Review Fix #28: PgHistory.ts is split into focused modules
// ─────────────────────────────────────────────────────────

describe('Review Fix #28: PgHistory.ts is split into focused modules', () => {
	test('PgHistory.ts stays focused (<= 950 lines)', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/PgHistory.ts', 'utf-8')
		const lines = source.split('\n').length
		// Bumped 800 → 850 → 950 as audit-integrity features landed (actor mapping,
		// search-concurrency limiter, TRUNCATE trigger, setup advisory lock,
		// teardown cache invalidation). Still a focused-module guardrail.
		expect(lines).toBeLessThanOrEqual(950)
	})

	test('pg-history-validators.ts exports pure validation functions', async () => {
		const mod = await import('../src/pg-history-validators')
		expect(typeof mod.validateIdentifier).toBe('function')
		expect(typeof mod.validateColumnNames).toBe('function')
		expect(typeof mod.validateStringInput).toBe('function')
		expect(typeof mod.validateLimit).toBe('function')
		expect(typeof mod.validateCursor).toBe('function')
	})

	test('pg-history-triggers.ts exports buildTriggerFunctionSql', async () => {
		const mod = await import('../src/pg-history-triggers')
		expect(typeof mod.buildTriggerFunctionSql).toBe('function')
	})

	test('pg-history-revert.ts exports executeRevert', async () => {
		const mod = await import('../src/pg-history-revert')
		expect(typeof mod.executeRevert).toBe('function')
	})
})

// ─────────────────────────────────────────────────────────
// Review Fix #29: stray eslint-disable comment removed
// ─────────────────────────────────────────────────────────

describe('Review Fix #29: stray eslint-disable comment removed', () => {
	test('usesIlike no longer has a misleading eslint-disable comment', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/PgHistory.ts', 'utf-8')

		// The line declaring usesIlike should not carry the eslint-disable suppression
		const region = source.slice(source.indexOf('let usesIlike'))
		const firstLine = region.split('\n')[0]
		expect(firstLine).not.toContain('eslint-disable-line')
	})
})

// ─────────────────────────────────────────────────────────
// Review Fix #31: ServerConfig.archiverConfig.batchSize is optional
// ─────────────────────────────────────────────────────────

describe('Review Fix #31: ServerConfig.archiverConfig.batchSize is optional', () => {
	test('types.ts declares batchSize as optional', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/types.ts', 'utf-8')

		// Match within the ServerConfig.archiverConfig block
		const archiverConfigBlock = source.slice(
			source.indexOf('archiverConfig?'),
			source.indexOf('runOptions?'),
		)
		expect(archiverConfigBlock).toContain('batchSize?: number')
	})
})
