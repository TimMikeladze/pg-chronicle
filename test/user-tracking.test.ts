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

	test('should associate user with subsequent operations via withUser', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		await audit.withUser('user-123', { ip: '1.2.3.4' }, async (client) => {
			await client.query(
				`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`,
			)
		})

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

		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com')`,
		)

		const logs = await pool.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'users'
    `)

		expect(logs.rows[0]?.changed_by).toBeNull()
	})

	test('should store metadata as JSONB via withUser', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		await audit.withUser(
			'user-456',
			{ ip: '5.6.7.8', action: 'api_call', requestId: 'req-789' },
			async (client) => {
				await client.query(
					`INSERT INTO users (name, email) VALUES ('Charlie', 'charlie@example.com')`,
				)
			},
		)

		const logs = await pool.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'users'
    `)

		expect(logs.rows[0]?.metadata?.ip).toBe('5.6.7.8')
		expect(logs.rows[0]?.metadata?.action).toBe('api_call')
		expect(logs.rows[0]?.metadata?.requestId).toBe('req-789')
	})

	test('should set user context on explicit client with setUser', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		const client = await pool.connect()
		try {
			await client.query('BEGIN')
			await audit.setUser(client, 'user-789', { role: 'admin' })
			await client.query(
				`INSERT INTO users (name, email) VALUES ('Dave', 'dave@example.com')`,
			)
			await client.query('COMMIT')
		} finally {
			client.release()
		}

		const logs = await pool.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'users'
    `)

		expect(logs.rows[0]?.changed_by).toBe('user-789')
		expect(logs.rows[0]?.metadata?.role).toBe('admin')
	})
})
