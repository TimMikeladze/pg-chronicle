import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { Orchestrator } from '../../src/orchestrator'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'
import { ensureTestBucket, putTestS3Object } from './helpers/s3'

describe('Orchestrator Integration', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await setupTestData(pool)
		await setupArchiverSchema(pool)

		// Ensure test bucket exists (S3 is always configured in tests)
		await ensureTestBucket('test-bucket')
	})

	afterEach(async () => {
		await cleanupTestData(pool)
		await pool.end()
	})

	test('should archive old records', async () => {
		// First, make all records recent
		await pool.query(`
      UPDATE audit_log
      SET changed_at = NOW()
      WHERE table_name = 'users'
    `)

		// Then mark only 30 records as old enough to archive
		await pool.query(`
      UPDATE audit_log
      SET changed_at = NOW() - INTERVAL '100 days'
      WHERE table_name = 'users'
        AND id IN (
          SELECT id FROM audit_log WHERE table_name = 'users' LIMIT 30
        )
    `)

		const orchestrator = new Orchestrator(
			{
				bucket: 'test-bucket',
				endpoint: process.env.PGHISTORY_S3_ENDPOINT,
				accessKeyId: process.env.PGHISTORY_S3_ACCESS_KEY_ID,
				secretAccessKey: process.env.PGHISTORY_S3_SECRET_ACCESS_KEY,
				region: process.env.PGHISTORY_S3_REGION,
			},
			{ default: 90 },
			7,
			10,
		)

		// Run with explicit target table (no trigger discovery needed)
		const stats = await orchestrator.run(pool, {
			targetTable: 'users',
		})

		expect(stats.totalRecordsArchived).toBe(30)

		// Verify records marked as archived
		const archived = await pool.query(`
      SELECT COUNT(*) as count
      FROM audit_log
      WHERE table_name = 'users'
        AND archived_at IS NOT NULL
    `)
		expect(Number(archived.rows[0].count)).toBe(30)
	})

	test('should soft delete archived records past grace period', async () => {
		// Create archived records past grace period with s3_path
		await pool.query(`
      UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '10 days',
          s3_path = 'test://fake-s3-path'
      WHERE table_name = 'users'
        AND id IN (
          SELECT id FROM audit_log WHERE table_name = 'users' LIMIT 30
        )
    `)

		const orchestrator = new Orchestrator(
			{
				bucket: 'test-bucket',
				endpoint: process.env.PGHISTORY_S3_ENDPOINT,
				accessKeyId: process.env.PGHISTORY_S3_ACCESS_KEY_ID,
				secretAccessKey: process.env.PGHISTORY_S3_SECRET_ACCESS_KEY,
				region: process.env.PGHISTORY_S3_REGION,
			},
			{ default: 90 },
			7,
			10,
		)

		const stats = await orchestrator.run(pool, {
			targetTable: 'users',
		})

		expect(stats.totalRecordsSoftDeleted).toBe(30)

		const softDeleted = await pool.query(`
      SELECT COUNT(*) as count
      FROM audit_log
      WHERE table_name = 'users'
        AND soft_deleted_at IS NOT NULL
    `)
		expect(Number(softDeleted.rows[0].count)).toBe(30)
	})

	test('should hard delete soft-deleted records past grace period', async () => {
		const testS3Key = 'test-archive/orchestrator-hard-delete.parquet'
		await putTestS3Object('test-bucket', testS3Key)

		// Create soft-deleted records past grace period with s3_path
		await pool.query(
			`UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '20 days',
          soft_deleted_at = NOW() - INTERVAL '10 days',
          s3_path = $1
      WHERE table_name = 'users'
        AND id IN (
          SELECT id FROM audit_log WHERE table_name = 'users' LIMIT 30
        )`,
			[testS3Key],
		)

		const initialCount = await pool.query(`
      SELECT COUNT(*) as count FROM audit_log WHERE table_name = 'users'
    `)

		const orchestrator = new Orchestrator(
			{
				bucket: 'test-bucket',
				endpoint: process.env.PGHISTORY_S3_ENDPOINT,
				accessKeyId: process.env.PGHISTORY_S3_ACCESS_KEY_ID,
				secretAccessKey: process.env.PGHISTORY_S3_SECRET_ACCESS_KEY,
				region: process.env.PGHISTORY_S3_REGION,
			},
			{ default: 90 },
			7,
			10,
		)

		const stats = await orchestrator.run(pool, {
			targetTable: 'users',
		})

		expect(stats.totalRecordsHardDeleted).toBe(30)

		const finalCount = await pool.query(`
      SELECT COUNT(*) as count FROM audit_log WHERE table_name = 'users'
    `)
		expect(Number(finalCount.rows[0].count)).toBe(
			Number(initialCount.rows[0].count) - 30,
		)
	})
})
