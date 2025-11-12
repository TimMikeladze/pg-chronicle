import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { Orchestrator } from '../../src/orchestrator'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'
import { ensureTestBucket, isS3Configured } from './helpers/s3'

describe('Orchestrator', () => {
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

	test('should discover tables from audit_log', async () => {
		const orchestrator = new Orchestrator({
			database: { url: 'not-used' },
			s3: { bucket: 'test' },
			retention: { default: 90 },
			gracePeriod: 7,
			batchSize: 100,
		})

		const tables = await orchestrator.discoverTables(sql)

		expect(tables).toContain('users')
		expect(tables.length).toBeGreaterThan(0)
	})

	test('should calculate retention cutoff date', () => {
		const orchestrator = new Orchestrator({
			database: { url: 'not-used' },
			s3: { bucket: 'test' },
			retention: {
				default: 90,
				tables: { users: 30 },
			},
			gracePeriod: 7,
			batchSize: 100,
		})

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
		await sql`
      UPDATE audit_log
      SET changed_at = NOW() - INTERVAL '100 days'
      WHERE table_name = 'users'
        AND id IN (
          SELECT id FROM audit_log WHERE table_name = 'users' LIMIT 50
        )
    `

		const orchestrator = new Orchestrator({
			database: { url: 'not-used' },
			s3: { bucket: 'test' },
			retention: { default: 90 },
			gracePeriod: 7,
			batchSize: 10,
		})

		const stats = await orchestrator.run(sql, { dryRun: true })

		expect(stats.totalRecordsArchived).toBe(0)
		expect(stats.totalRecordsSoftDeleted).toBe(0)
		expect(stats.totalRecordsHardDeleted).toBe(0)

		// Verify no records were actually archived
		const archived = await sql`
      SELECT COUNT(*) as count
      FROM audit_log
      WHERE archived_at IS NOT NULL
    `
		expect(Number(archived[0].count)).toBe(0)
	})
})
