import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { Orchestrator } from '../../src/orchestrator'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'
import { ensureTestBucket, isS3Configured } from './helpers/s3'

describe('Orchestrator Integration', () => {
	let sql: SQL

	beforeEach(async () => {
		sql = await getTestConnection()
		await setupTestData(sql)
		await setupArchiverSchema(sql)

		// Ensure test bucket exists if S3 is configured
		if (isS3Configured()) {
			await ensureTestBucket('test-bucket')
		}
	})

	afterEach(async () => {
		await cleanupTestData(sql)
		await sql.close()
	})

	test('should archive old records (skip S3 upload in test)', async () => {
		// First, make all records recent
		await sql`
      UPDATE audit_log
      SET changed_at = NOW()
      WHERE table_name = 'users'
    `

		// Then mark only 30 records as old enough to archive
		await sql`
      UPDATE audit_log
      SET changed_at = NOW() - INTERVAL '100 days'
      WHERE table_name = 'users'
        AND id IN (
          SELECT id FROM audit_log WHERE table_name = 'users' LIMIT 30
        )
    `

		const orchestrator = new Orchestrator({
			database: { url: 'not-used' },
			s3: {
				bucket: 'test-bucket',
				endpoint: 'http://localhost:9000',
			},
			retention: { default: 90 },
			gracePeriod: 7,
			batchSize: 10,
		})

		// This will fail on S3 upload, but that's expected in test
		const stats = await orchestrator.run(sql, { skipS3Upload: true })

		expect(stats.totalRecordsArchived).toBe(30)

		// Verify records marked as archived
		const archived = await sql`
      SELECT COUNT(*) as count
      FROM audit_log
      WHERE table_name = 'users'
        AND archived_at IS NOT NULL
    `
		expect(Number(archived[0].count)).toBe(30)
	})

	test('should soft delete archived records past grace period', async () => {
		// Create archived records past grace period
		await sql`
      UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '10 days'
      WHERE table_name = 'users'
        AND id IN (
          SELECT id FROM audit_log WHERE table_name = 'users' LIMIT 30
        )
    `

		const orchestrator = new Orchestrator({
			database: { url: 'not-used' },
			s3: { bucket: 'test' },
			retention: { default: 90 },
			gracePeriod: 7,
			batchSize: 10,
		})

		const stats = await orchestrator.run(sql, { skipS3Upload: true })

		expect(stats.totalRecordsSoftDeleted).toBe(30)

		const softDeleted = await sql`
      SELECT COUNT(*) as count
      FROM audit_log
      WHERE table_name = 'users'
        AND soft_deleted_at IS NOT NULL
    `
		expect(Number(softDeleted[0].count)).toBe(30)
	})

	test('should hard delete soft-deleted records past grace period', async () => {
		// Create soft-deleted records past grace period
		await sql`
      UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '20 days',
          soft_deleted_at = NOW() - INTERVAL '10 days'
      WHERE table_name = 'users'
        AND id IN (
          SELECT id FROM audit_log WHERE table_name = 'users' LIMIT 30
        )
    `

		const initialCount = await sql`
      SELECT COUNT(*) as count FROM audit_log WHERE table_name = 'users'
    `

		const orchestrator = new Orchestrator({
			database: { url: 'not-used' },
			s3: { bucket: 'test' },
			retention: { default: 90 },
			gracePeriod: 7,
			batchSize: 10,
		})

		const stats = await orchestrator.run(sql, { skipS3Upload: true })

		expect(stats.totalRecordsHardDeleted).toBe(30)

		const finalCount = await sql`
      SELECT COUNT(*) as count FROM audit_log WHERE table_name = 'users'
    `
		expect(Number(finalCount[0].count)).toBe(Number(initialCount[0].count) - 30)
	})
})
