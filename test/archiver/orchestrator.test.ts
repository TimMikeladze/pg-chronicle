import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { Orchestrator } from '../../src/orchestrator'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'
import { ensureTestBucket, isS3Configured } from './helpers/s3'

describe('Orchestrator', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await setupTestData(pool)
		await setupArchiverSchema(pool)

		// Ensure test bucket exists if S3 is configured
		if (await isS3Configured()) {
			await ensureTestBucket('test-bucket')
		}
	})

	afterEach(async () => {
		await cleanupTestData(pool)
		await pool.end()
	})

	test('should discover tables from triggers', async () => {
		// Create a dummy table and trigger for testing discovery
		await pool.query(`
			CREATE TABLE IF NOT EXISTS test_table (id INT PRIMARY KEY)
		`)
		await pool.query(`
			CREATE OR REPLACE FUNCTION audit_trigger_func_test_table()
			RETURNS TRIGGER AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql
		`)
		await pool.query(`
			CREATE TRIGGER audit_trigger_test_table
			AFTER INSERT ON test_table
			FOR EACH ROW EXECUTE FUNCTION audit_trigger_func_test_table()
		`)

		const orchestrator = new Orchestrator(
			{ bucket: 'test' },
			{ default: 90 },
			7,
			100,
		)

		const tables = await orchestrator.discoverTables(pool)

		expect(tables).toContain('test_table')
		expect(tables.length).toBeGreaterThan(0)
	})

	test('should calculate retention cutoff date', () => {
		const orchestrator = new Orchestrator(
			{ bucket: 'test' },
			{
				default: 90,
				tables: { users: 30 },
			},
			7,
			100,
		)

		const defaultCutoff = orchestrator.getRetentionCutoff('orders')
		const customCutoff = orchestrator.getRetentionCutoff('users')

		const now = new Date()
		const expectedDefault = new Date(now)
		expectedDefault.setDate(expectedDefault.getDate() - 90)

		const expectedCustom = new Date(now)
		expectedCustom.setDate(expectedCustom.getDate() - 30)

		// Allow 1 second tolerance
		expect(
			Math.abs(defaultCutoff.getTime() - expectedDefault.getTime()),
		).toBeLessThan(1000)
		expect(
			Math.abs(customCutoff.getTime() - expectedCustom.getTime()),
		).toBeLessThan(1000)
	})

	test('should run in dry-run mode without making changes', async () => {
		// Mark some records as old
		await pool.query(`
      UPDATE audit_log
      SET changed_at = NOW() - INTERVAL '100 days'
      WHERE table_name = 'users'
        AND id IN (
          SELECT id FROM audit_log WHERE table_name = 'users' LIMIT 50
        )
    `)

		const orchestrator = new Orchestrator(
			{ bucket: 'test' },
			{ default: 90 },
			7,
			10,
		)

		const stats = await orchestrator.run(pool, { dryRun: true })

		expect(stats.totalRecordsArchived).toBe(0)
		expect(stats.totalRecordsSoftDeleted).toBe(0)
		expect(stats.totalRecordsHardDeleted).toBe(0)

		// Verify no records were actually archived
		const archived = await pool.query(`
      SELECT COUNT(*) as count
      FROM audit_log
      WHERE archived_at IS NOT NULL
    `)
		expect(Number(archived.rows[0].count)).toBe(0)
	})
})
