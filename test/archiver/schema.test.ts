import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'

describe('Schema Setup', () => {
	let sql: SQL

	beforeEach(async () => {
		sql = await getTestConnection()
		await setupTestData(sql)
	})

	afterEach(async () => {
		await cleanupTestData(sql)
		await sql.close()
	})

	test('should add archived_at column to audit_log', async () => {
		await setupArchiverSchema(sql)

		const result = await sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'audit_log'
      AND column_name = 'archived_at'
    `

		expect(result.length).toBe(1)
		expect(result[0].data_type).toBe('timestamp without time zone')
	})

	test('should create audit_archive_metadata table', async () => {
		await setupArchiverSchema(sql)

		const result = await sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_name = 'audit_archive_metadata'
    `

		expect(result.length).toBe(1)
	})

	test('should create indexes on audit_log', async () => {
		await setupArchiverSchema(sql)

		const result = await sql`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'audit_log'
      AND indexname = 'idx_audit_log_archived'
    `

		expect(result.length).toBe(1)
	})

	test('should add soft_deleted_at column to audit_log', async () => {
		await setupArchiverSchema(sql)

		const result = await sql`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'audit_log'
      AND column_name = 'soft_deleted_at'
    `

		expect(result.length).toBe(1)
		expect(result[0].data_type).toBe('timestamp with time zone')
	})

	test('should create index on soft_deleted_at', async () => {
		await setupArchiverSchema(sql)

		const result = await sql`
      SELECT indexname
      FROM pg_indexes
      WHERE tablename = 'audit_log'
      AND indexname = 'idx_audit_log_soft_deleted'
    `

		expect(result.length).toBe(1)
	})
})
