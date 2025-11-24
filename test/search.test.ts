import { beforeEach, describe, expect, test } from 'bun:test'
import { PgHistory } from '../src'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgHistory.search', () => {
	beforeEach(async () => {
		const pool = await getTestConnection()
		await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      )
    `)
		await pool.query(`
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        total NUMERIC
      )
    `)
	})

	test('should search across JSONB data', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users', 'orders'] })
		await audit.setup()

		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`,
		)
		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com')`,
		)

		const result = await audit.search({
			tables: ['users'],
			query: 'alice',
		})

		expect(result.data.length).toBeGreaterThan(0)
		expect(result.data[0]?.newData?.name).toBe('Alice')
	})

	test('should search across multiple tables', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users', 'orders'] })
		await audit.setup()

		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Charlie', 'charlie@example.com')`,
		)
		await pool.query(`INSERT INTO orders (user_id, total) VALUES (1, 99.99)`)

		const result = await audit.search({
			tables: ['users', 'orders'],
			query: 'charlie',
		})

		expect(result.data.length).toBeGreaterThan(0)
	})

	test('should filter by operation', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		await pool.query(
			`INSERT INTO users (name, email) VALUES ('David', 'david@example.com')`,
		)
		await pool.query(
			`UPDATE users SET email = 'david2@example.com' WHERE name = 'David'`,
		)

		const result = await audit.search({
			tables: ['users'],
			query: 'david',
			operation: 'UPDATE',
		})

		expect(result.data.length).toBe(1)
		expect(result.data[0]?.operation).toBe('UPDATE')
	})

	test('should filter by date range', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		const now = new Date()
		const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
		const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000)

		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Eve', 'eve@example.com')`,
		)

		const result = await audit.search({
			tables: ['users'],
			dateFrom: yesterday,
			dateTo: tomorrow,
		})

		expect(result.data.length).toBe(1)
	})

	test('should support pagination', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		// Create multiple entries
		for (let i = 1; i <= 5; i++) {
			await pool.query(`INSERT INTO users (name, email) VALUES ($1, $2)`, [
				`User${i}`,
				`user${i}@example.com`,
			])
		}

		const page1 = await audit.search({
			tables: ['users'],
			limit: 2,
		})

		expect(page1.data.length).toBe(2)
		expect(page1.hasMore).toBe(true)

		expect(page1.nextCursor).toBeDefined()
		const page2 = await audit.search({
			tables: ['users'],
			limit: 2,
			cursor: page1.nextCursor ?? undefined,
		})

		expect(page2.data.length).toBe(2)
	})

	test('should filter by changedBy', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		await audit.setUser('user-123', { action: 'api' })
		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Frank', 'frank@example.com')`,
		)

		await new Promise((resolve) => setTimeout(resolve, 100))

		await audit.setUser('user-456', { action: 'api' })
		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Grace', 'grace@example.com')`,
		)

		await new Promise((resolve) => setTimeout(resolve, 100))

		const result = await audit.search({
			tables: ['users'],
			changedBy: 'user-123',
		})

		expect(result.data.length).toBe(1)
		expect(result.data[0]?.newData?.name).toBe('Frank')
	})
})
