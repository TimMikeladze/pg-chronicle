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

	test('server should initialize PgHistory when historyConfig provided', async () => {
		const pool = await getTestConnection()
		const app = await createServer({
			pool,
			port: 3001,
			enableHistory: true,
			historyConfig: {
				tables: ['users'],
			},
		})

		// Make a request that would fail if PgHistory not initialized
		const res = await app.request('/health')
		expect(res.status).toBe(200)
	})
})

describe('GET /api/history/:table/:recordId', () => {
	test('should return 401 without JWT when secret is set', async () => {
		process.env.PG_HISTORY_JWT_SECRET = 'test-secret'

		const pool = await getTestConnection()
		const app = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] },
		})

		const res = await app.request('/api/history/users/123')
		expect(res.status).toBe(401)

		delete process.env.PG_HISTORY_JWT_SECRET
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

		// Create server (which initializes PgHistory)
		const app = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] },
		})

		// Get the pgHistory instance from the app context to set it up
		const { PgHistory } = await import('../src/PgHistory')
		const pgHistory = new PgHistory({ tables: ['users'], pool })
		await pgHistory.setup()

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

		await pgHistory.teardown()
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

		// Then setup PgHistory to install triggers
		const { PgHistory } = await import('../src/PgHistory')
		const pgHistory = new PgHistory({ tables: ['users', 'posts'], pool })
		await pgHistory.setup()

		// Now insert data which will be captured by triggers
		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)
		await pool.query(`INSERT INTO posts (id, title) VALUES (1, 'Hello World')`)

		const app = await createServer({
			pool,
			enableHistory: true,
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

		await pgHistory.teardown()
	})

	test('should return 400 for empty tables array', async () => {
		const pool = await getTestConnection()
		const app = await createServer({
			pool,
			enableHistory: true,
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
