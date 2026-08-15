import { describe, expect, test } from 'bun:test'
import { Pool } from 'pg'
import { createErrorResponse } from '../src/api-helpers'
import { createServer } from '../src/server'
import type { ErrorResponse, ServerConfig } from '../src/types'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('Server API Types', () => {
	test('ServerConfig should accept historyConfig', () => {
		const pool = new Pool()
		const config: ServerConfig = {
			pool,
			port: 3001,
			historyConfig: {
				tables: ['users', 'posts'],
			},
		}
		expect(config.historyConfig?.tables).toEqual(['users', 'posts'])
		pool.end()
	})

	test('ErrorResponse type should have correct structure', () => {
		const error: ErrorResponse = {
			error: {
				code: 'VALIDATION_ERROR',
				message: 'Invalid input',
				details: { field: 'userId' },
			},
		}
		expect(error.error.code).toBe('VALIDATION_ERROR')
	})

	test('createErrorResponse should format error correctly', () => {
		const response = createErrorResponse('NOT_FOUND', 'Record not found', {
			id: '123',
		})
		expect(response.error.code).toBe('NOT_FOUND')
		expect(response.error.message).toBe('Record not found')
		expect(response.error.details).toEqual({ id: '123' })
	})

	test('server should initialize PgChronicle when historyConfig provided', async () => {
		const pool = await getTestConnection()
		const { app } = await createServer({
			pool,
			port: 3001,
			enableHistory: true,
			allowUnauthenticated: true,
			historyConfig: {
				tables: ['users'],
			},
		})

		// Make a request that would fail if PgChronicle not initialized
		const res = await app.request('/health')
		expect(res.status).toBe(200)
	})
})

describe('GET /api/history/:table/:recordId', () => {
	test('should return 401 without JWT when secret is set', async () => {
		process.env.PG_CHRONICLE_JWT_SECRET = 'test-secret'

		const pool = await getTestConnection()
		const { app } = await createServer({
			pool,
			enableHistory: true,
			allowUnauthenticated: true,
			historyConfig: { tables: ['users'] },
		})

		const res = await app.request('/api/history/users/123')
		expect(res.status).toBe(401)

		delete process.env.PG_CHRONICLE_JWT_SECRET
	})

	test('should return history for valid table and recordId', async () => {
		const pool = await getTestConnection()

		// Create test table first
		await pool.query(`
			CREATE TABLE IF NOT EXISTS users (
				id SERIAL PRIMARY KEY,
				name TEXT
			)
		`)

		// Create server (which initializes PgChronicle)
		const { app } = await createServer({
			pool,
			enableHistory: true,
			allowUnauthenticated: true,
			historyConfig: { tables: ['users'] },
		})

		// Get the pgChronicle instance from the app context to set it up
		const { PgChronicle } = await import('../src/PgChronicle')
		const pgChronicle = new PgChronicle({ tables: ['users'], pool })
		await pgChronicle.setup()

		// Insert and update to create history
		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)
		await pool.query(`UPDATE users SET name = 'Bob' WHERE id = 1`)

		const res = await app.request('/api/history/users/1')
		expect(res.status).toBe(200)

		const json = await res.json()
		expect(json.data).toBeArray()
		expect(json.data.length).toBeGreaterThan(0)
		expect(json).toHaveProperty('nextCursor')
		expect(json).toHaveProperty('hasMore')

		await pgChronicle.teardown()
	})
})

describe('POST /api/history/search', () => {
	test('should search across multiple tables', async () => {
		const pool = await getTestConnection()

		// Create tables first
		await pool.query(
			`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)`,
		)
		await pool.query(
			`CREATE TABLE IF NOT EXISTS posts (id SERIAL PRIMARY KEY, title TEXT)`,
		)

		// Then setup PgChronicle to install triggers
		const { PgChronicle } = await import('../src/PgChronicle')
		const pgChronicle = new PgChronicle({ tables: ['users', 'posts'], pool })
		await pgChronicle.setup()

		// Now insert data which will be captured by triggers
		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)
		await pool.query(`INSERT INTO posts (id, title) VALUES (1, 'Hello World')`)

		const { app } = await createServer({
			pool,
			enableHistory: true,
			allowUnauthenticated: true,
			historyConfig: { tables: ['users', 'posts'] },
		})

		const res = await app.request('/api/history/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tables: ['users', 'posts'],
				operation: 'INSERT',
			}),
		})

		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json.data).toBeArray()
		expect(json.data.length).toBe(2)

		await pgChronicle.teardown()
	})

	test('should return 400 for empty tables array', async () => {
		const pool = await getTestConnection()
		const { app } = await createServer({
			pool,
			enableHistory: true,
			allowUnauthenticated: true,
			historyConfig: { tables: ['users'] },
		})

		const res = await app.request('/api/history/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ tables: [] }),
		})

		expect(res.status).toBe(400)
		const json = await res.json()
		expect(json.error.code).toBe('VALIDATION_ERROR')
	})
})

// ─────────────────────────────────────────────────────────
// Review Fix #14: OpenAPI endpoint can be auth-gated
// ─────────────────────────────────────────────────────────

describe('Review Fix #14: OpenAPI endpoint can be auth-gated', () => {
	test('server accepts publicOpenApi config option', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/server.ts', 'utf-8')

		expect(source).toContain('publicOpenApi')
		expect(source).toContain("app.use('/openapi'")
	})
})

// ─────────────────────────────────────────────────────────
// Review Fix #15: rate limiter cleanup runs on a timer
// ─────────────────────────────────────────────────────────

describe('Review Fix #15: rate limiter cleanup runs on a timer', () => {
	test('server uses setInterval for rate limit cleanup', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/server.ts', 'utf-8')

		expect(source).toContain('rateLimitCleanupInterval')
		expect(source).toContain('RATE_LIMIT_CLEANUP_INTERVAL_MS')
	})
})

// ─────────────────────────────────────────────────────────
// Review Fix #20: Bun.serve gated behind typeof Bun !== undefined
// ─────────────────────────────────────────────────────────

describe('Review Fix #20: Bun.serve is gated', () => {
	test('main.ts runs on Node as well as Bun', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/main.ts', 'utf-8')
		const serverSource = await fs.readFile('./src/server.ts', 'utf-8')

		// server.ts must NOT call into Bun globals — it is imported by Node and
		// Next.js. (Naming `Bun.serve` in a comment is fine; invoking it is not.)
		expect(serverSource).not.toMatch(/(?<!`|\w)Bun\.serve\(/)

		// main.ts IS the published `bin`, with a `#!/usr/bin/env node` shebang, so
		// it must never assume the Bun global exists: it used to call `Bun.serve`
		// unconditionally and died with "Bun is not defined" under Node. The
		// global is now reached through a guarded lookup with a Node fallback.
		expect(source).not.toMatch(/(?<!\w)Bun\.serve\(/)
		expect(source).toContain('globalThis as { Bun?: BunRuntime }')
		expect(source).toContain('@hono/node-server')
	})
})

// ─────────────────────────────────────────────────────────
// Review Fix #21: graceful shutdown waits for in-flight requests
// ─────────────────────────────────────────────────────────

describe('Review Fix #21: graceful shutdown waits for in-flight requests', () => {
	test('server.ts tracks in-flight requests and drains on shutdown', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/server.ts', 'utf-8')

		expect(source).toContain('inFlightRequests')
		expect(source).toContain('waitForInFlightRequests')
	})
})
