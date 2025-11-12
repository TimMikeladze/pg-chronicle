import { beforeEach, describe, expect, test } from 'bun:test'
import { PgHistory } from '../src'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgHistory triggers', () => {
	beforeEach(async () => {
		const sql = await getTestConnection()

		// Create a test table
		await sql`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      )
    `
	})

	test('should capture INSERT operations', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		// Insert a user
		await sql`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`

		// Check audit log
		const logs = await sql`
      SELECT * FROM audit_log
      WHERE table_name = 'users'
      AND operation = 'INSERT'
    `

		expect(logs.length).toBe(1)
		expect(logs[0]?.new_data?.name).toBe('Alice')
		expect(logs[0]?.old_data).toBeNull()
	})

	test('should capture UPDATE operations', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		// Insert then update
		await sql`INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com')`
		await sql`UPDATE users SET email = 'bob.new@example.com' WHERE name = 'Bob'`

		// Check audit log for UPDATE
		const logs = await sql`
      SELECT * FROM audit_log
      WHERE table_name = 'users'
      AND operation = 'UPDATE'
    `

		expect(logs.length).toBe(1)
		expect(logs[0]?.old_data?.email).toBe('bob@example.com')
		expect(logs[0]?.new_data?.email).toBe('bob.new@example.com')
	})

	test('should capture DELETE operations', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		// Insert then delete
		await sql`INSERT INTO users (name, email) VALUES ('Charlie', 'charlie@example.com')`
		await sql`DELETE FROM users WHERE name = 'Charlie'`

		// Check audit log for DELETE
		const logs = await sql`
      SELECT * FROM audit_log
      WHERE table_name = 'users'
      AND operation = 'DELETE'
    `

		expect(logs.length).toBe(1)
		expect(logs[0]?.old_data?.name).toBe('Charlie')
		expect(logs[0]?.new_data).toBeNull()
	})

	test('should extract record_id correctly', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		// Insert a user
		const [user] = await sql`
      INSERT INTO users (name, email)
      VALUES ('David', 'david@example.com')
      RETURNING id
    `

		// Check audit log has correct record_id
		const logs = await sql`
      SELECT * FROM audit_log
      WHERE table_name = 'users'
      AND operation = 'INSERT'
    `

		expect(logs[0]?.record_id).toBe(user.id.toString())
	})

	test('should handle table with non-standard primary key (user_id)', async () => {
		const sql = await getTestConnection()

		// Create table with user_id as primary key
		await sql`
      CREATE TABLE profiles (
        user_id SERIAL PRIMARY KEY,
        bio TEXT,
        avatar_url TEXT
      )
    `

		const audit = new PgHistory({ sql, tables: ['profiles'] })
		await audit.setup()

		// Insert a profile
		const [profile] = await sql`
      INSERT INTO profiles (bio, avatar_url)
      VALUES ('Hello world', 'https://example.com/avatar.jpg')
      RETURNING user_id
    `

		// Check audit log has correct record_id
		const logs = await sql`
      SELECT * FROM audit_log
      WHERE table_name = 'profiles'
      AND operation = 'INSERT'
    `

		expect(logs.length).toBe(1)
		expect(logs[0]?.record_id).toBe(profile.user_id.toString())
		expect(logs[0]?.new_data?.bio).toBe('Hello world')
	})

	test('should handle table with composite primary key', async () => {
		const sql = await getTestConnection()

		// Create table with composite primary key
		await sql`
      CREATE TABLE user_roles (
        user_id INTEGER NOT NULL,
        role_id INTEGER NOT NULL,
        granted_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, role_id)
      )
    `

		const audit = new PgHistory({ sql, tables: ['user_roles'] })
		await audit.setup()

		// Insert a user role
		await sql`
      INSERT INTO user_roles (user_id, role_id)
      VALUES (123, 456)
    `

		// Check audit log has correct composite record_id
		const logs = await sql`
      SELECT * FROM audit_log
      WHERE table_name = 'user_roles'
      AND operation = 'INSERT'
    `

		expect(logs.length).toBe(1)
		// Composite key should be concatenated with '|' delimiter
		expect(logs[0]?.record_id).toBe('123|456')
		expect(logs[0]?.new_data?.user_id).toBe(123)
		expect(logs[0]?.new_data?.role_id).toBe(456)
	})

	test('should handle table with no primary key', async () => {
		const sql = await getTestConnection()

		// Create table without primary key
		await sql`
      CREATE TABLE logs (
        message TEXT,
        level TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `

		const audit = new PgHistory({ sql, tables: ['logs'] })
		await audit.setup()

		// Insert a log entry
		await sql`
      INSERT INTO logs (message, level)
      VALUES ('Test message', 'INFO')
    `

		// Check audit log exists (record_id will be a hash)
		const logs = await sql`
      SELECT * FROM audit_log
      WHERE table_name = 'logs'
      AND operation = 'INSERT'
    `

		expect(logs.length).toBe(1)
		// record_id should be a MD5 hash (32 character hex string)
		expect(logs[0]?.record_id).toMatch(/^[a-f0-9]{32}$/)
		expect(logs[0]?.new_data?.message).toBe('Test message')
	})
})
