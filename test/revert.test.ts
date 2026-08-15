import { beforeEach, describe, expect, test } from 'bun:test'
import { PgChronicle } from '../src'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgChronicle.revert', () => {
	beforeEach(async () => {
		const pool = await getTestConnection()
		await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      )
    `)
	})

	test('should revert record to old_data from audit entry', async () => {
		const pool = await getTestConnection()
		const audit = new PgChronicle({ pool, tables: ['users'] })
		await audit.setup()

		// Create and modify a user
		await pool.query(
			`INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice1@example.com')`,
		)
		await pool.query(
			`UPDATE users SET email = 'alice2@example.com' WHERE id = 1`,
		)
		await pool.query(
			`UPDATE users SET email = 'alice3@example.com' WHERE id = 1`,
		)

		// Get history to find audit entry for first update
		const history = await audit.getHistory('users', '1')
		const firstUpdate = history.data.find(
			(e) => e.newData?.email === 'alice2@example.com',
		)

		// Revert using that audit entry (will restore to old_data of that entry)
		expect(firstUpdate).toBeDefined()
		await audit.revert('users', '1', firstUpdate?.id ?? '')

		// Check current state - should be reverted to old_data (alice1)
		const result = await pool.query(`SELECT * FROM users WHERE id = 1`)
		const user = result.rows[0]
		expect(user.email).toBe('alice1@example.com')
	})

	test('should use old_data for UPDATE revert, new_data for INSERT revert', async () => {
		const pool = await getTestConnection()
		const audit = new PgChronicle({ pool, tables: ['users'] })
		await audit.setup()

		// Create user and update
		await pool.query(
			`INSERT INTO users (id, name, email) VALUES (1, 'Charlie', 'charlie1@example.com')`,
		)
		await pool.query(
			`UPDATE users SET email = 'charlie2@example.com' WHERE id = 1`,
		)

		const history = await audit.getHistory('users', '1')

		// Revert to UPDATE's old_data
		const updateEntry = history.data[0]
		expect(updateEntry).toBeDefined()
		await audit.revert('users', '1', updateEntry?.id ?? '')

		const result = await pool.query(`SELECT * FROM users WHERE id = 1`)
		const user = result.rows[0]
		expect(user.email).toBe('charlie1@example.com')
	})

	test('should throw error if audit entry not found', async () => {
		const pool = await getTestConnection()
		const audit = new PgChronicle({ pool, tables: ['users'] })
		await audit.setup()

		await pool.query(
			`INSERT INTO users (id, name, email) VALUES (1, 'David', 'david@example.com')`,
		)

		await expect(async () => {
			await audit.revert('users', '1', '99999')
		}).toThrow()
	})

	test('should revert a DELETE by re-inserting the row', async () => {
		const pool = await getTestConnection()
		const audit = new PgChronicle({ pool, tables: ['users'] })
		await audit.setup()

		// Insert then delete
		await pool.query(
			`INSERT INTO users (id, name, email) VALUES (1, 'Frank', 'frank@example.com')`,
		)
		await pool.query(`DELETE FROM users WHERE id = 1`)

		// Verify row is gone
		const gone = await pool.query(`SELECT * FROM users WHERE id = 1`)
		expect(gone.rows.length).toBe(0)

		// Find the DELETE audit entry
		const history = await audit.getHistory('users', '1')
		const deleteEntry = history.data.find((e) => e.operation === 'DELETE')
		expect(deleteEntry).toBeDefined()

		// Revert the DELETE — should re-insert the row
		await audit.revert('users', '1', deleteEntry?.id ?? '')

		// Verify row is back
		const result = await pool.query(`SELECT * FROM users WHERE id = 1`)
		expect(result.rows.length).toBe(1)
		expect(result.rows[0].name).toBe('Frank')
		expect(result.rows[0].email).toBe('frank@example.com')
	})

	test('should revert an INSERT by deleting the row', async () => {
		const pool = await getTestConnection()
		const audit = new PgChronicle({ pool, tables: ['users'] })
		await audit.setup()

		await pool.query(
			`INSERT INTO users (id, name, email) VALUES (1, 'Grace', 'grace@example.com')`,
		)

		// Find the INSERT audit entry
		const history = await audit.getHistory('users', '1')
		const insertEntry = history.data.find((e) => e.operation === 'INSERT')
		expect(insertEntry).toBeDefined()

		// Revert the INSERT — should delete the row
		await audit.revert('users', '1', insertEntry?.id ?? '')

		// Verify row is gone
		const result = await pool.query(`SELECT * FROM users WHERE id = 1`)
		expect(result.rows.length).toBe(0)
	})
})
