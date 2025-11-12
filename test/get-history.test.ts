import { beforeEach, describe, expect, test } from 'bun:test'
import { PgHistory } from '../src'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgHistory.getHistory', () => {
	beforeEach(async () => {
		const sql = await getTestConnection()
		await sql`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      )
    `
	})

	test('should return paginated history for a record', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		// Create some history
		await sql`INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com')`
		await sql`UPDATE users SET email = 'alice2@example.com' WHERE id = 1`
		await sql`UPDATE users SET email = 'alice3@example.com' WHERE id = 1`

		// Get history
		const result = await audit.getHistory('users', '1', { limit: 2 })

		expect(result.data.length).toBe(2)
		expect(result.hasMore).toBe(true)
		expect(result.nextCursor).toBeDefined()
	})

	test('should return results in descending order by default', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		await sql`INSERT INTO users (id, name, email) VALUES (1, 'Bob', 'bob1@example.com')`
		await sql`UPDATE users SET email = 'bob2@example.com' WHERE id = 1`
		await sql`UPDATE users SET email = 'bob3@example.com' WHERE id = 1`

		const result = await audit.getHistory('users', '1')

		// Most recent first
		expect(result.data[0]?.operation).toBe('UPDATE')
		expect(result.data[0]?.newData?.email).toBe('bob3@example.com')
	})

	test('should support cursor-based pagination', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		// Create 5 changes
		await sql`INSERT INTO users (id, name, email) VALUES (1, 'Charlie', 'c1@example.com')`
		for (let i = 2; i <= 5; i++) {
			await sql`UPDATE users SET email = ${`c${i}@example.com`} WHERE id = 1`
		}

		// Get first page
		const page1 = await audit.getHistory('users', '1', { limit: 2 })
		expect(page1.data.length).toBe(2)
		expect(page1.hasMore).toBe(true)

		// Get second page
		expect(page1.nextCursor).toBeDefined()
		const page2 = await audit.getHistory('users', '1', {
			limit: 2,
			cursor: page1.nextCursor ?? undefined,
		})
		expect(page2.data.length).toBe(2)
		expect(page2.hasMore).toBe(true)

		// Get third page
		expect(page2.nextCursor).toBeDefined()
		const page3 = await audit.getHistory('users', '1', {
			limit: 2,
			cursor: page2.nextCursor ?? undefined,
		})
		expect(page3.data.length).toBe(1)
		expect(page3.hasMore).toBe(false)
	})

	test('should support ascending order', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		await sql`INSERT INTO users (id, name, email) VALUES (1, 'David', 'd1@example.com')`
		await sql`UPDATE users SET email = 'd2@example.com' WHERE id = 1`
		await sql`UPDATE users SET email = 'd3@example.com' WHERE id = 1`

		const result = await audit.getHistory('users', '1', { order: 'asc' })

		// Oldest first
		expect(result.data[0]?.operation).toBe('INSERT')
		expect(result.data[0]?.newData?.email).toBe('d1@example.com')
	})
})
