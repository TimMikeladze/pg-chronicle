import { describe, expect, test } from 'bun:test'
import { PgHistory } from '../src'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgHistory.setup', () => {
	test('should create audit_log table', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })

		await audit.setup()

		// Check table exists
		const tables = await pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename = 'audit_log'
    `)

		expect(tables.rows.length).toBe(1)
	})

	test('should create partition for each table', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users', 'orders'] })

		await audit.setup()

		// Check partitions exist
		const partitions = await pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      AND (tablename = 'audit_log_users' OR tablename = 'audit_log_orders')
    `)

		expect(partitions.rows.length).toBe(2)
	})

	test('should create indexes on audit_log', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })

		await audit.setup()

		// Check specific indexes exist
		const indexes = await pool.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
      AND tablename = 'audit_log'
    `)

		const indexNames = indexes.rows.map(
			(idx: { indexname: string }) => idx.indexname,
		)

		// Verify all expected indexes exist
		expect(indexNames).toContain('idx_audit_old_data_gin')
		expect(indexNames).toContain('idx_audit_new_data_gin')
		expect(indexNames).toContain('idx_audit_changed_at')
		expect(indexNames).toContain('idx_audit_record_id')
	})

	test('should be idempotent - running setup twice works', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })

		await audit.setup()
		await audit.setup() // Should not error

		const tables = await pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename = 'audit_log'
    `)

		expect(tables.rows.length).toBe(1)
	})

	test('should reject invalid table names', async () => {
		const pool = await getTestConnection()

		// Test various invalid table names
		expect(
			() => new PgHistory({ pool, tables: ['users; DROP TABLE audit_log;'] }),
		).toThrow('Invalid table name')
		expect(() => new PgHistory({ pool, tables: ['users--'] })).toThrow(
			'Invalid table name',
		)
		expect(() => new PgHistory({ pool, tables: ['123users'] })).toThrow(
			'Invalid table name',
		)
		expect(() => new PgHistory({ pool, tables: ['user-name'] })).toThrow(
			'Invalid table name',
		)
		expect(() => new PgHistory({ pool, tables: ['user name'] })).toThrow(
			'Invalid table name',
		)
	})

	test('should accept valid table names', async () => {
		const pool = await getTestConnection()

		// These should not throw
		expect(() => new PgHistory({ pool, tables: ['users'] })).not.toThrow()
		expect(() => new PgHistory({ pool, tables: ['_users'] })).not.toThrow()
		expect(() => new PgHistory({ pool, tables: ['users_table'] })).not.toThrow()
		expect(() => new PgHistory({ pool, tables: ['users123'] })).not.toThrow()
		expect(() => new PgHistory({ pool, tables: ['UsErS'] })).not.toThrow()
	})
})
