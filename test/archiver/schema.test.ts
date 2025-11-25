import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'

describe('Schema Setup', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await setupTestData(pool)
	})

	afterEach(async () => {
		await cleanupTestData(pool)
		await pool.end()
	})

	test('should add archived_at column to audit_log', async () => {
		await setupArchiverSchema(pool)

		const result = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'audit_log'
      AND column_name = 'archived_at'
    `)

		expect(result.rows.length).toBe(1)
		expect(result.rows[0].data_type).toBe('timestamp with time zone')
	})

	test('should create audit_archive_metadata table', async () => {
		await setupArchiverSchema(pool)

		const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name = 'audit_archive_metadata'
    `)

		expect(result.rows.length).toBe(1)
	})

	test('should create indexes on audit_log', async () => {
		await setupArchiverSchema(pool)

		const result = await pool.query(`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'audit_log'
      AND indexname LIKE 'idx_audit_log_%'
    `)

		// Should have: idx_audit_log_archival, idx_audit_log_soft_delete, idx_audit_log_hard_delete
		expect(result.rows.length).toBeGreaterThanOrEqual(3)
	})

	test('should add soft_deleted_at column to audit_log', async () => {
		await setupArchiverSchema(pool)

		const result = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'audit_log'
      AND column_name = 'soft_deleted_at'
    `)

		expect(result.rows.length).toBe(1)
		expect(result.rows[0].data_type).toBe('timestamp with time zone')
	})

	test('should create s3_path column', async () => {
		await setupArchiverSchema(pool)

		const result = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'audit_log'
      AND column_name = 's3_path'
    `)

		expect(result.rows.length).toBe(1)
		expect(result.rows[0].data_type).toBe('text')
	})

	test('should create audit_archival_stats table', async () => {
		await setupArchiverSchema(pool)

		const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name = 'audit_archival_stats'
    `)

		expect(result.rows.length).toBe(1)
	})
})
