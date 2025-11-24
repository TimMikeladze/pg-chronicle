import { beforeEach, describe, expect, test } from 'bun:test'
import { PgHistory } from '../src'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgHistory.setUser', () => {
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

	test('should associate user with subsequent operations', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		// Set user context
		await audit.setUser('user-123', { ip: '1.2.3.4' })

		// Insert a user
		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`,
		)

		// Small delay for correlation
		await new Promise((resolve) => setTimeout(resolve, 100))

		// Check audit log has user info
		const logs = await pool.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'users'
    `)

		expect(logs.rows[0]?.changed_by).toBe('user-123')
		expect(logs.rows[0]?.metadata?.ip).toBe('1.2.3.4')
	})

	test('should handle operations without user context', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		// Clear any user context from previous tests
		await audit.clearUser()

		// Insert without setting user
		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com')`,
		)

		// Check audit log
		const logs = await pool.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'users'
    `)

		expect(logs.rows[0]?.changed_by).toBeNull()
	})

	test('should store metadata as JSONB', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		await audit.setUser('user-456', {
			ip: '5.6.7.8',
			action: 'api_call',
			requestId: 'req-789',
		})

		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Charlie', 'charlie@example.com')`,
		)

		await new Promise((resolve) => setTimeout(resolve, 100))

		const logs = await pool.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'users'
    `)

		expect(logs.rows[0]?.metadata?.ip).toBe('5.6.7.8')
		expect(logs.rows[0]?.metadata?.action).toBe('api_call')
		expect(logs.rows[0]?.metadata?.requestId).toBe('req-789')
	})
})
