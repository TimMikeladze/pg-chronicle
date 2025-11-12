import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { PgHistoryArchiver } from '../../src/PgHistoryArchiver'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'
import { ensureTestBucket, isS3Configured } from './helpers/s3'

describe('PgHistoryArchiver - Soft Delete', () => {
	let sql: SQL
	let archiver: PgHistoryArchiver

	beforeEach(async () => {
		sql = await getTestConnection()
		await setupTestData(sql)
		await setupArchiverSchema(sql)

		// Ensure test bucket exists if S3 is configured
		if (isS3Configured()) {
			await ensureTestBucket('test-bucket')
		}

		archiver = new PgHistoryArchiver({
			sql,
			s3: {
				bucket: 'test-bucket',
				endpoint: process.env.S3_ENDPOINT,
				accessKeyId: process.env.S3_ACCESS_KEY_ID,
				secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
				region: process.env.S3_REGION,
			},
			retention: { default: 90 },
			gracePeriod: 7,
			batchSize: 10,
		})
	})

	afterEach(async () => {
		await cleanupTestData(sql)
		await sql.close()
	})

	test('should mark archived records as soft deleted', async () => {
		// First, mark some records as archived past the grace period
		const result = await sql`
      UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '10 days'
      WHERE table_name = 'users' AND id LIKE 'old-%'
    `

		const updatedCount = result.count || 0
		expect(updatedCount).toBeGreaterThan(0)

		// Soft delete archived records older than grace period (7 days)
		const count = await archiver.softDeleteArchived('users')

		expect(count).toBe(updatedCount)

		// Verify soft_deleted_at is set
		const softDeleted = await sql`
      SELECT COUNT(*) as count
      FROM audit_log
      WHERE table_name = 'users'
        AND soft_deleted_at IS NOT NULL
    `

		expect(Number(softDeleted[0].count)).toBe(updatedCount)
	})

	test('should not soft delete recently archived records', async () => {
		// Mark records as archived within grace period (3 days < 7 days grace period)
		await sql`
      UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '3 days'
      WHERE table_name = 'users' AND id LIKE 'old-%'
    `

		const count = await archiver.softDeleteArchived('users')

		// Should not soft delete because they're within the grace period
		expect(count).toBe(0)
	})

	test('should not soft delete already soft-deleted records', async () => {
		// Mark records as archived and already soft deleted
		await sql`
      UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '10 days',
          soft_deleted_at = NOW() - INTERVAL '5 days'
      WHERE table_name = 'users' AND id LIKE 'old-%'
    `

		const count = await archiver.softDeleteArchived('users')

		// Should be 0 because they're already soft deleted
		expect(count).toBe(0)
	})
})
