import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { PgHistoryArchiver } from '../../src/PgHistoryArchiver'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'
import { ensureTestBucket, isS3Configured } from './helpers/s3'

describe('PgHistoryArchiver - Soft Delete', () => {
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

	test('should mark archived records as soft deleted', async () => {
		// First, mark some records as archived past the grace period with s3_path
		const result = await pool.query(`
      UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '10 days',
          s3_path = 'test://fake-s3-path'
      WHERE table_name = 'users' AND id LIKE 'old-%'
    `)

		const updatedCount = result.rowCount || 0
		expect(updatedCount).toBeGreaterThan(0)

		// Soft delete archived records older than grace period (7 days)
		// softDeleteArchived is batched, so loop until all are processed
		let totalSoftDeleted = 0
		let batchCount = 0
		while (true) {
			const count = await archiver.softDeleteArchived('users')
			totalSoftDeleted += count
			if (count === 0) break
			batchCount++
		}

		expect(totalSoftDeleted).toBe(updatedCount)
		expect(batchCount).toBeGreaterThan(0)

		// Verify soft_deleted_at is set
		const softDeleted = await pool.query(`
      SELECT COUNT(*) as count
      FROM audit_log
      WHERE table_name = 'users'
        AND soft_deleted_at IS NOT NULL
    `)

		expect(Number(softDeleted.rows[0].count)).toBe(updatedCount)
	})

	test('should not soft delete recently archived records', async () => {
		// Mark records as archived within grace period (3 days < 7 days grace period) with s3_path
		await pool.query(`
      UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '3 days',
          s3_path = 'test://fake-s3-path'
      WHERE table_name = 'users' AND id LIKE 'old-%'
    `)

		const count = await archiver.softDeleteArchived('users')

		// Should not soft delete because they're within the grace period
		expect(count).toBe(0)
	})

	test('should not soft delete already soft-deleted records', async () => {
		// Mark records as archived and already soft deleted with s3_path
		await pool.query(`
      UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '10 days',
          soft_deleted_at = NOW() - INTERVAL '5 days',
          s3_path = 'test://fake-s3-path'
      WHERE table_name = 'users' AND id LIKE 'old-%'
    `)

		const count = await archiver.softDeleteArchived('users')

		// Should be 0 because they're already soft deleted
		expect(count).toBe(0)
	})
})
