import { beforeEach, describe, expect, test } from 'bun:test'
import { PgHistory } from '../src'
import { buildTriggerFunctionSql } from '../src/pg-history-triggers'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgHistory triggers', () => {
	beforeEach(async () => {
		const pool = await getTestConnection()

		// Create a test table
		await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      )
    `)
	})

	test('should capture INSERT operations', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		// Insert a user
		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`,
		)

		// Check audit log
		const logs = await pool.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'users'
      AND operation = 'INSERT'
    `)

		expect(logs.rows.length).toBe(1)
		expect(logs.rows[0]?.new_data?.name).toBe('Alice')
		expect(logs.rows[0]?.old_data).toBeNull()
	})

	test('should capture UPDATE operations', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		// Insert then update
		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com')`,
		)
		await pool.query(
			`UPDATE users SET email = 'bob.new@example.com' WHERE name = 'Bob'`,
		)

		// Check audit log for UPDATE
		const logs = await pool.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'users'
      AND operation = 'UPDATE'
    `)

		expect(logs.rows.length).toBe(1)
		expect(logs.rows[0]?.old_data?.email).toBe('bob@example.com')
		expect(logs.rows[0]?.new_data?.email).toBe('bob.new@example.com')
	})

	test('should capture DELETE operations', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		// Insert then delete
		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Charlie', 'charlie@example.com')`,
		)
		await pool.query(`DELETE FROM users WHERE name = 'Charlie'`)

		// Check audit log for DELETE
		const logs = await pool.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'users'
      AND operation = 'DELETE'
    `)

		expect(logs.rows.length).toBe(1)
		expect(logs.rows[0]?.old_data?.name).toBe('Charlie')
		expect(logs.rows[0]?.new_data).toBeNull()
	})

	test('should extract record_id correctly', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		// Insert a user
		const user = await pool.query(`
      INSERT INTO users (name, email)
      VALUES ('David', 'david@example.com')
      RETURNING id
    `)

		// Check audit log has correct record_id
		const logs = await pool.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'users'
      AND operation = 'INSERT'
    `)

		expect(logs.rows[0]?.record_id).toBe(user.rows[0].id.toString())
	})

	test('should handle table with non-standard primary key (user_id)', async () => {
		const pool = await getTestConnection()

		// Create table with user_id as primary key
		await pool.query(`
      CREATE TABLE profiles (
        user_id SERIAL PRIMARY KEY,
        bio TEXT,
        avatar_url TEXT
      )
    `)

		const audit = new PgHistory({ pool, tables: ['profiles'] })
		await audit.setup()

		// Insert a profile
		const profile = await pool.query(`
      INSERT INTO profiles (bio, avatar_url)
      VALUES ('Hello world', 'https://example.com/avatar.jpg')
      RETURNING user_id
    `)

		// Check audit log has correct record_id
		const logs = await pool.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'profiles'
      AND operation = 'INSERT'
    `)

		expect(logs.rows.length).toBe(1)
		expect(logs.rows[0]?.record_id).toBe(profile.rows[0].user_id.toString())
		expect(logs.rows[0]?.new_data?.bio).toBe('Hello world')
	})

	test('should handle table with composite primary key', async () => {
		const pool = await getTestConnection()

		// Create table with composite primary key
		await pool.query(`
      CREATE TABLE user_roles (
        user_id INTEGER NOT NULL,
        role_id INTEGER NOT NULL,
        granted_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, role_id)
      )
    `)

		const audit = new PgHistory({ pool, tables: ['user_roles'] })
		await audit.setup()

		// Insert a user role
		await pool.query(`
      INSERT INTO user_roles (user_id, role_id)
      VALUES (123, 456)
    `)

		// Check audit log has correct composite record_id
		const logs = await pool.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'user_roles'
      AND operation = 'INSERT'
    `)

		expect(logs.rows.length).toBe(1)
		// Composite key is concatenated with ASCII unit separator chr(31) as delimiter
		expect(logs.rows[0]?.record_id).toBe('123\x1f456')
		expect(logs.rows[0]?.new_data?.user_id).toBe(123)
		expect(logs.rows[0]?.new_data?.role_id).toBe(456)
	})

	test('should handle table with no primary key', async () => {
		const pool = await getTestConnection()

		// Create table without primary key
		await pool.query(`
      CREATE TABLE logs (
        message TEXT,
        level TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)

		const audit = new PgHistory({ pool, tables: ['logs'] })
		await audit.setup()

		// Insert a log entry
		await pool.query(`
      INSERT INTO logs (message, level)
      VALUES ('Test message', 'INFO')
    `)

		// Check audit log exists (record_id will be a hash)
		const logs = await pool.query(`
      SELECT * FROM audit_log
      WHERE table_name = 'logs'
      AND operation = 'INSERT'
    `)

		expect(logs.rows.length).toBe(1)
		// record_id should be a MD5 hash (32 character hex string)
		expect(logs.rows[0]?.record_id).toMatch(/^[a-f0-9]{32}$/)
		expect(logs.rows[0]?.new_data?.message).toBe('Test message')
	})
})

// ─────────────────────────────────────────────────────────
// buildTriggerFunctionSql — pure function extracted for unit testing
// ─────────────────────────────────────────────────────────

describe('buildTriggerFunctionSql', () => {
	test('generates function for single-column primary key', () => {
		const sql = buildTriggerFunctionSql({
			schema: 'public',
			funcName: 'audit_trigger_func_users',
			pkColumns: ['id'],
			auditTable: '"public"."audit_log"',
		})
		expect(sql).toContain(
			'CREATE OR REPLACE FUNCTION "public"."audit_trigger_func_users"()',
		)
		expect(sql).toContain('OLD."id"::text')
		expect(sql).toContain('NEW."id"::text')
		expect(sql).toContain('"public"."audit_log"')
	})

	test('generates function for composite primary key', () => {
		const sql = buildTriggerFunctionSql({
			schema: 'public',
			funcName: 'audit_trigger_func_order_items',
			pkColumns: ['order_id', 'item_id'],
			auditTable: '"public"."audit_log"',
		})
		expect(sql).toContain('COALESCE(NEW."order_id"::text')
		expect(sql).toContain('COALESCE(NEW."item_id"::text')
		expect(sql).toContain('|| chr(31) ||')
	})

	test('generates function for no primary key (md5 hash)', () => {
		const sql = buildTriggerFunctionSql({
			schema: 'public',
			funcName: 'audit_trigger_func_logs',
			pkColumns: [],
			auditTable: '"public"."audit_log"',
		})
		expect(sql).toContain('md5(row_to_json(OLD)::text)')
		expect(sql).toContain('md5(row_to_json(NEW)::text)')
	})
})
