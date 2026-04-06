import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { PgHistoryArchiver } from '../../src/PgHistoryArchiver'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'
import { ensureTestBucket, isS3Configured, putTestS3Object } from './helpers/s3'

describe('PgHistoryArchiver - Hard Delete', () => {
	let pool: Pool
	let archiver: PgHistoryArchiver

	beforeEach(async () => {
		pool = await getTestConnection()
		await setupTestData(pool)
		await setupArchiverSchema(pool)

		// Ensure test bucket exists if S3 is configured
		if (await isS3Configured()) {
			await ensureTestBucket('test-bucket')
		}

		archiver = new PgHistoryArchiver({
			pool,
			s3: {
				bucket: 'test-bucket',
				endpoint: process.env.PG_HISTORY_S3_ENDPOINT,
				accessKeyId: process.env.PG_HISTORY_S3_ACCESS_KEY_ID,
				secretAccessKey: process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY,
				region: process.env.PG_HISTORY_S3_REGION,
			},
			retention: { default: 90 },
			gracePeriod: 7,
			batchSize: 10,
		})
	})

	afterEach(async () => {
		await cleanupTestData(pool)
		await pool.end()
	})

	test('should permanently delete soft-deleted records past grace period', async () => {
		const testS3Key = 'test-archive/hard-delete-test.parquet'
		await putTestS3Object('test-bucket', testS3Key)

		// Create soft-deleted records past grace period with s3_path set
		await pool.query(
			`UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '20 days',
          soft_deleted_at = NOW() - INTERVAL '10 days',
          s3_path = $1
      WHERE table_name = 'users' AND id LIKE 'old-%'`,
			[testS3Key],
		)

		const initialCount = await pool.query(`
      SELECT COUNT(*) as count FROM audit_log WHERE table_name = 'users'
    `)

		const deleted = await archiver.hardDeletePurged('users')

		expect(deleted).toBeGreaterThan(0)

		const finalCount = await pool.query(`
      SELECT COUNT(*) as count FROM audit_log WHERE table_name = 'users'
    `)

		expect(Number(finalCount.rows[0].count)).toBe(
			Number(initialCount.rows[0].count) - deleted,
		)
	})

	test('should not delete recently soft-deleted records', async () => {
		// Create soft-deleted records within grace period
		await pool.query(`
      UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '15 days',
          soft_deleted_at = NOW() - INTERVAL '3 days'
      WHERE table_name = 'users' AND id LIKE 'old-%'
    `)

		const deleted = await archiver.hardDeletePurged('users')

		expect(deleted).toBe(0)
	})

	test('should not delete records without soft_deleted_at', async () => {
		const initialCount = await pool.query(`
      SELECT COUNT(*) as count FROM audit_log
      WHERE table_name = 'users' AND soft_deleted_at IS NULL
    `)

		const deleted = await archiver.hardDeletePurged('users')

		const finalCount = await pool.query(`
      SELECT COUNT(*) as count FROM audit_log
      WHERE table_name = 'users' AND soft_deleted_at IS NULL
    `)

		// No records should be deleted, so count should be 0
		expect(deleted).toBe(0)
		expect(Number(finalCount.rows[0].count)).toBe(
			Number(initialCount.rows[0].count),
		)
	})
})
