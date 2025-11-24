import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { PgHistoryArchiver } from '../../src/PgHistoryArchiver'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'
import { ensureTestBucket, isS3Configured } from './helpers/s3'

describe('PgHistoryArchiver - Hard Delete', () => {
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
		await cleanupTestData(sql)
		await sql.close()
	})

	test('should permanently delete soft-deleted records past grace period', async () => {
		// Create soft-deleted records past grace period
		await sql`
      UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '20 days',
          soft_deleted_at = NOW() - INTERVAL '10 days'
      WHERE table_name = 'users' AND id LIKE 'old-%'
    `

		const initialCount = await sql`
      SELECT COUNT(*) as count FROM audit_log WHERE table_name = 'users'
    `

		const deleted = await archiver.hardDeletePurged('users')

		expect(deleted).toBeGreaterThan(0)

		const finalCount = await sql`
      SELECT COUNT(*) as count FROM audit_log WHERE table_name = 'users'
    `

		expect(Number(finalCount[0].count)).toBe(
			Number(initialCount[0].count) - deleted,
		)
	})

	test('should not delete recently soft-deleted records', async () => {
		// Create soft-deleted records within grace period
		await sql`
      UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '15 days',
          soft_deleted_at = NOW() - INTERVAL '3 days'
      WHERE table_name = 'users' AND id LIKE 'old-%'
    `

		const deleted = await archiver.hardDeletePurged('users')

		expect(deleted).toBe(0)
	})

	test('should not delete records without soft_deleted_at', async () => {
		const initialCount = await sql`
      SELECT COUNT(*) as count FROM audit_log
      WHERE table_name = 'users' AND soft_deleted_at IS NULL
    `

		const deleted = await archiver.hardDeletePurged('users')

		const finalCount = await sql`
      SELECT COUNT(*) as count FROM audit_log
      WHERE table_name = 'users' AND soft_deleted_at IS NULL
    `

		// No records should be deleted, so count should be 0
		expect(deleted).toBe(0)
		expect(Number(finalCount[0].count)).toBe(Number(initialCount[0].count))
	})
})
