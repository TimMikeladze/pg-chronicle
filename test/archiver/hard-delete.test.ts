import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { PgChronicleArchiver } from '../../src/PgChronicleArchiver'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'
import { ensureTestBucket, isS3Configured, putTestS3Object } from './helpers/s3'

describe('PgChronicleArchiver - Hard Delete', () => {
	let pool: Pool
	let archiver: PgChronicleArchiver

	beforeEach(async () => {
		pool = await getTestConnection()
		await setupTestData(pool)
		await setupArchiverSchema(pool)

		// Ensure test bucket exists if S3 is configured
		if (await isS3Configured()) {
			await ensureTestBucket('test-bucket')
		}

		archiver = new PgChronicleArchiver({
			pool,
			s3: {
				bucket: 'test-bucket',
				endpoint: process.env.PG_CHRONICLE_S3_ENDPOINT,
				accessKeyId: process.env.PG_CHRONICLE_S3_ACCESS_KEY_ID,
				secretAccessKey: process.env.PG_CHRONICLE_S3_SECRET_ACCESS_KEY,
				region: process.env.PG_CHRONICLE_S3_REGION,
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

		// Create soft-deleted records past grace period with s3_path set.
		// Target "old" rows by their original changed_at (2024-01-15) instead
		// of id prefix — the helper now uses BIGSERIAL ids.
		await pool.query(
			`UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '20 days',
          soft_deleted_at = NOW() - INTERVAL '10 days',
          s3_path = $1
      WHERE table_name = 'users' AND changed_at < '2025-01-01'`,
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
		// Create soft-deleted records within grace period (target old rows by date)
		await pool.query(`
      UPDATE audit_log
      SET archived_at = NOW() - INTERVAL '15 days',
          soft_deleted_at = NOW() - INTERVAL '3 days'
      WHERE table_name = 'users' AND changed_at < '2025-01-01'
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

// ─────────────────────────────────────────────────────────
// Review Fix #18: hardDeletePurged closes TOCTOU window with row locks
// ─────────────────────────────────────────────────────────

describe('Review Fix #18: hardDeletePurged uses row locks', () => {
	test('hardDeletePurged wraps delete in a transaction with FOR UPDATE', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/PgChronicleArchiver.ts', 'utf-8')

		const region = source.slice(source.indexOf('async hardDeletePurged'))
		// The implementation must use BEGIN, SELECT FOR UPDATE, and commit/rollback
		expect(region).toContain('BEGIN')
		expect(region).toContain('FOR UPDATE')
		expect(region).toContain('COMMIT')
		expect(region).toContain('ROLLBACK')
	})
})
