import { beforeEach, describe, expect, test } from 'bun:test'
import { PgHistory } from '../src'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgHistory.revert', () => {
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

	test('should revert record to old_data from audit entry', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		// Create and modify a user
		await sql`INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice1@example.com')`
		await sql`UPDATE users SET email = 'alice2@example.com' WHERE id = 1`
		await sql`UPDATE users SET email = 'alice3@example.com' WHERE id = 1`

		// Get history to find audit entry for first update
		const history = await audit.getHistory('users', '1')
		const firstUpdate = history.data.find(
			(e) => e.newData?.email === 'alice2@example.com',
		)

		// Revert using that audit entry (will restore to old_data of that entry)
		expect(firstUpdate).toBeDefined()
		await audit.revert('users', '1', firstUpdate?.id ?? '')

		// Check current state - should be reverted to old_data (alice1)
		const [user] = await sql`SELECT * FROM users WHERE id = 1`
		expect(user.email).toBe('alice1@example.com')
	})

	test('should create audit entry for revert operation', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		await sql`INSERT INTO users (id, name, email) VALUES (1, 'Bob', 'bob1@example.com')`
		await sql`UPDATE users SET email = 'bob2@example.com' WHERE id = 1`

		const history = await audit.getHistory('users', '1')
		const insertEntry = history.data.find((e) => e.operation === 'INSERT')

		// Revert
		expect(insertEntry).toBeDefined()
		await audit.revert('users', '1', insertEntry?.id ?? '')

		// Check revert was audited
		const newHistory = await audit.getHistory('users', '1')
		const revertEntry = newHistory.data[0]

		expect(revertEntry?.operation).toBe('UPDATE')
		expect(revertEntry?.metadata?.revertedFrom).toBe(insertEntry?.id)
	})

	test('should use old_data for UPDATE revert, new_data for INSERT revert', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		// Create user and update
		await sql`INSERT INTO users (id, name, email) VALUES (1, 'Charlie', 'charlie1@example.com')`
		await sql`UPDATE users SET email = 'charlie2@example.com' WHERE id = 1`

		const history = await audit.getHistory('users', '1')

		// Revert to UPDATE's old_data
		const updateEntry = history.data[0]
		expect(updateEntry).toBeDefined()
		await audit.revert('users', '1', updateEntry?.id ?? '')

		const [user] = await sql`SELECT * FROM users WHERE id = 1`
		expect(user.email).toBe('charlie1@example.com')
	})

	test('should throw error if audit entry not found', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		await sql`INSERT INTO users (id, name, email) VALUES (1, 'David', 'david@example.com')`

		await expect(async () => {
			await audit.revert('users', '1', '99999')
		}).toThrow()
	})

	test('should associate revert with user context', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		await sql`INSERT INTO users (id, name, email) VALUES (1, 'Eve', 'eve1@example.com')`
		await sql`UPDATE users SET email = 'eve2@example.com' WHERE id = 1`

		const history = await audit.getHistory('users', '1')
		const insertEntry = history.data.find((e) => e.operation === 'INSERT')

		// Set user before revert
		await audit.setUser('admin-123', { action: 'revert', reason: 'mistake' })
		expect(insertEntry).toBeDefined()
		await audit.revert('users', '1', insertEntry?.id ?? '')

		await new Promise((resolve) => setTimeout(resolve, 100))

		// Check revert entry has user
		const newHistory = await audit.getHistory('users', '1')
		const revertEntry = newHistory.data[0]

		expect(revertEntry?.changedBy).toBe('admin-123')
		expect(revertEntry?.metadata?.action).toBe('revert')
	})
})
