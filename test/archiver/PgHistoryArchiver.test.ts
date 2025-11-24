import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { PgHistoryArchiver } from '../../src/PgHistoryArchiver'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'
import { ensureTestBucket, isS3Configured } from './helpers/s3'

describe('PgHistoryArchiver - Batch Query', () => {
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
			retention: {
				default: 90,
			},
			gracePeriod: 7,
			batchSize: 10,
		})
	})

	afterEach(async () => {
		await cleanupTestData(sql)
		await sql.close()
	})

	test('should query old records based on retention policy', async () => {
		const cutoffDate = new Date()
		cutoffDate.setDate(cutoffDate.getDate() - 90)

		const records = await archiver.queryOldRecords('users', cutoffDate, 10)

		expect(records.length).toBeGreaterThan(0)
		expect(records.length).toBeLessThanOrEqual(10)

		// All records should be older than cutoff
		for (const record of records) {
			const recordDate =
				record.changed_at instanceof Date
					? record.changed_at
					: new Date(record.changed_at as string)
			expect(recordDate.getTime()).toBeLessThan(cutoffDate.getTime())
		}
	})

	test('should not query recent records', async () => {
		const cutoffDate = new Date()
		cutoffDate.setDate(cutoffDate.getDate() - 1) // 1 day ago

		const records = await archiver.queryOldRecords('users', cutoffDate, 100)

		// Should only get old records (from 2024-01-15), not recent ones
		expect(records.length).toBe(100)
		expect(
			records.every((r: Record<string, unknown>) =>
				(r.id as string).startsWith('old-'),
			),
		).toBe(true)
	})

	test('should generate correct S3 path with Hive partitioning', () => {
		const date = new Date('2025-01-15T10:30:00Z')
		const path = archiver.generateS3Path('users', date, 1)

		expect(path).toBe('users/year=2025/month=01/day=15/part-00001.parquet')
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
				1,
			)

			expect(s3Path).toContain('users/year=2025/month=01/day=15')
			expect(s3Path).toEndWith('.parquet')
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
			retention: {
				default: 90,
			},
			gracePeriod: 7,
			batchSize: 10,
		})
	})

	afterEach(async () => {
		await cleanupTestData(sql)
		await sql.close()
	})

	test('should process batch with transaction', async () => {
		// Check if MinIO is available
		try {
			const cutoffDate = new Date()
			cutoffDate.setDate(cutoffDate.getDate() - 100)

			// Process one batch
			const result = await archiver.processBatch('users', cutoffDate, 1)

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

			await archiver.processBatch('users', cutoffDate, 1)

			// Check that records were marked
			const archived = await sql`
    SELECT COUNT(*) as count
    FROM audit_log
    WHERE table_name = 'users'
      AND archived_at IS NOT NULL
  `

			expect(Number(archived[0].count)).toBe(10)
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
			sql,
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
			badArchiver.processBatch('users', cutoffDate, 1),
		).rejects.toThrow()

		// Verify no records were marked as archived
		const archived = await sql`
    SELECT COUNT(*) as count
    FROM audit_log
    WHERE archived_at IS NOT NULL
  `

		expect(Number(archived[0].count)).toBe(0)
	})
})
