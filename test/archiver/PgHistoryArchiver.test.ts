import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { PgHistoryArchiver } from '../../src/PgHistoryArchiver'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'
import { ensureTestBucket, isS3Configured } from './helpers/s3'

describe('PgHistoryArchiver - Batch Query', () => {
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
			retention: {
				default: 90,
			},
			gracePeriod: 7,
			batchSize: 10,
		})
	})

	afterEach(async () => {
		await cleanupTestData(pool)
		await pool.end()
	})

	test('should process batch and mark records as archived', async () => {
		const cutoffDate = new Date()
		cutoffDate.setDate(cutoffDate.getDate() - 90)

		// Check count before
		const beforeCount = await pool.query(
			`SELECT COUNT(*) as count
			 FROM audit_log
			 WHERE table_name = 'users'
			   AND changed_at < $1
			   AND archived_at IS NULL`,
			[cutoffDate],
		)

		const initialCount = Number.parseInt(beforeCount.rows[0]?.count || '0', 10)
		expect(initialCount).toBeGreaterThan(0)

		// Process one batch (batch size is 10)
		const result = await archiver.processBatch('users', cutoffDate)

		expect(result.recordCount).toBeGreaterThan(0)
		expect(result.recordCount).toBeLessThanOrEqual(10)
		expect(result.s3Path).toMatch(
			/^users\/year=\d{4}\/month=\d{2}\/day=\d{2}\//,
		)
		expect(result.status).toBe('completed')

		// Verify records are marked as archived
		const afterCount = await pool.query(
			`SELECT COUNT(*) as count
			 FROM audit_log
			 WHERE table_name = 'users'
			   AND changed_at < $1
			   AND archived_at IS NULL`,
			[cutoffDate],
		)

		const remainingCount = Number.parseInt(afterCount.rows[0]?.count || '0', 10)
		expect(remainingCount).toBe(initialCount - result.recordCount)
	})

	test('should generate correct S3 path with Hive partitioning', () => {
		const date = new Date('2025-01-15T10:30:00Z')
		const path = archiver.generateS3Path('users', date)

		expect(path).toMatch(
			/^users\/year=2025\/month=01\/day=15\/data-[0-9a-f-]{36}\.parquet$/,
		)
	})

	test('should upload Parquet file to S3', async () => {
		const records = [
			{
				id: 'test-1',
				table_name: 'users',
				record_id: 'user-1',
				operation: 'INSERT',
				changed_at: new Date('2025-01-15'),
				new_data: { name: 'Alice' },
				old_data: null,
				changed_by: 'system',
				metadata: null,
			},
		]

		// Check if MinIO is available and properly configured
		try {
			const s3Path = await archiver.uploadBatchToS3(
				records,
				'users',
				new Date('2025-01-15'),
			)

			expect(s3Path).toContain('users/year=2025/month=01/day=15')
			expect(s3Path).toMatch(/data-[0-9a-f-]{36}\.parquet$/)
		} catch (error) {
			// Skip test if S3 is not properly configured (bucket missing, wrong credentials, etc)
			console.error(error)
			if (
				error &&
				typeof error === 'object' &&
				'code' in error &&
				(error.code === 'NoSuchBucket' ||
					error.code === 'InvalidAccessKeyId' ||
					error.code === 'ERR_S3_MISSING_CREDENTIALS')
			) {
				console.log(
					'⚠️  Skipping S3 upload test - MinIO not configured with test bucket/credentials',
				)
				return
			}
			throw error
		}
	})
})

describe('PgHistoryArchiver - Batch Processing', () => {
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
			retention: {
				default: 90,
			},
			gracePeriod: 7,
			batchSize: 10,
		})
	})

	afterEach(async () => {
		await cleanupTestData(pool)
		await pool.end()
	})

	test('should process batch with transaction', async () => {
		// Check if MinIO is available
		try {
			const cutoffDate = new Date()
			cutoffDate.setDate(cutoffDate.getDate() - 100)

			// Process one batch
			const result = await archiver.processBatch('users', cutoffDate)

			expect(result.recordCount).toBe(10) // batchSize is 10
			expect(result.s3Path).toContain('users/year=')
			expect(result.status).toBe('completed')
		} catch (error) {
			// Skip test if S3 is not properly configured
			console.error(error)
			if (
				error &&
				typeof error === 'object' &&
				'code' in error &&
				(error.code === 'NoSuchBucket' ||
					error.code === 'InvalidAccessKeyId' ||
					error.code === 'ERR_S3_MISSING_CREDENTIALS')
			) {
				console.log(
					'⚠️  Skipping batch processing test - MinIO not configured with test bucket/credentials',
				)
				return
			}
			throw error
		}
	})

	test('should mark records as archived after successful upload', async () => {
		// Check if MinIO is available
		try {
			const cutoffDate = new Date()
			cutoffDate.setDate(cutoffDate.getDate() - 100)

			await archiver.processBatch('users', cutoffDate)

			// Check that records were marked
			const archived = await pool.query(`
    SELECT COUNT(*) as count
    FROM audit_log
    WHERE table_name = 'users'
      AND archived_at IS NOT NULL
  `)

			expect(Number(archived.rows[0].count)).toBe(10)
		} catch (error) {
			// Skip test if S3 is not properly configured
			if (
				error &&
				typeof error === 'object' &&
				'code' in error &&
				(error.code === 'NoSuchBucket' ||
					error.code === 'InvalidAccessKeyId' ||
					error.code === 'ERR_S3_MISSING_CREDENTIALS')
			) {
				console.log(
					'⚠️  Skipping mark archived test - MinIO not configured with test bucket/credentials',
				)
				return
			}
			throw error
		}
	})

	test('should rollback on S3 upload failure', async () => {
		// Create archiver with invalid S3 config to force failure
		const badArchiver = new PgHistoryArchiver({
			pool,
			s3: {
				bucket: 'invalid-bucket',
				endpoint: process.env.PG_HISTORY_S3_ENDPOINT,
				accessKeyId: process.env.PG_HISTORY_S3_ACCESS_KEY_ID,
				secretAccessKey: process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY,
				region: process.env.PG_HISTORY_S3_REGION,
			},
			retention: { default: 90 },
			gracePeriod: 7,
			batchSize: 10,
		})

		const cutoffDate = new Date()
		cutoffDate.setDate(cutoffDate.getDate() - 100)

		await expect(
			badArchiver.processBatch('users', cutoffDate),
		).rejects.toThrow()

		// Verify no records were marked as archived
		const archived = await pool.query(`
    SELECT COUNT(*) as count
    FROM audit_log
    WHERE archived_at IS NOT NULL
  `)

		expect(Number(archived.rows[0].count)).toBe(0)
	})
})
