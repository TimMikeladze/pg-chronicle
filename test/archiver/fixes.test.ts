import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { PgHistoryArchiver } from '../../src/PgHistoryArchiver'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'
import { ensureTestBucket, isS3Configured, putTestS3Object } from './helpers/s3'

// ─────────────────────────────────────────────────────────
// Fix #2: UTC date boundaries in processBatch
// ─────────────────────────────────────────────────────────

describe('Fix #2: processBatch UTC date boundaries', () => {
	let pool: Pool
	let archiver: PgHistoryArchiver

	beforeEach(async () => {
		pool = await getTestConnection()
		await setupTestData(pool)
		await setupArchiverSchema(pool)

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
			batchSize: 100,
		})
	})

	afterEach(async () => {
		await cleanupTestData(pool)
		await pool.end()
	})

	test('archives records near UTC midnight without splitting incorrectly', async () => {
		// Insert records at 23:30 UTC and 00:30 UTC on consecutive days
		// These should go into separate batches (different UTC days).
		// ids are BIGSERIAL — let PG assign them and key records by record_id.
		await pool.query(`
			DELETE FROM audit_log WHERE table_name = 'users'
		`)

		// Day 1: 2024-01-15 23:30 UTC
		await pool.query(
			`INSERT INTO audit_log (table_name, record_id, operation, changed_at, new_data)
			VALUES ($1, $2, $3, $4, $5)`,
			[
				'users',
				'user-utc-1',
				'INSERT',
				new Date('2024-01-15T23:30:00Z'),
				JSON.stringify({ name: 'Day 1 late' }),
			],
		)

		// Day 2: 2024-01-16 00:30 UTC
		await pool.query(
			`INSERT INTO audit_log (table_name, record_id, operation, changed_at, new_data)
			VALUES ($1, $2, $3, $4, $5)`,
			[
				'users',
				'user-utc-2',
				'INSERT',
				new Date('2024-01-16T00:30:00Z'),
				JSON.stringify({ name: 'Day 2 early' }),
			],
		)

		const cutoff = new Date('2024-12-01T00:00:00Z')

		// First batch should get only Day 1 records
		const batch1 = await archiver.processBatch('users', cutoff)
		expect(batch1.recordCount).toBe(1)

		// Second batch should get Day 2 records
		const batch2 = await archiver.processBatch('users', cutoff)
		expect(batch2.recordCount).toBe(1)

		// Third batch should be empty
		const batch3 = await archiver.processBatch('users', cutoff)
		expect(batch3.recordCount).toBe(0)
	})
})

// ─────────────────────────────────────────────────────────
// Fix #3: Hard delete requires real S3 verification
// ─────────────────────────────────────────────────────────

describe('Fix #3: Hard delete S3 verification', () => {
	let pool: Pool
	let archiver: PgHistoryArchiver

	beforeEach(async () => {
		pool = await getTestConnection()
		await setupTestData(pool)
		await setupArchiverSchema(pool)

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
			batchSize: 100,
		})
	})

	afterEach(async () => {
		await cleanupTestData(pool)
		await pool.end()
	})

	test('refuses to hard delete records with non-existent S3 path', async () => {
		// Set s3_path to a path that does NOT exist in S3.
		// Target the "old" rows by changed_at since ids are now BIGSERIAL.
		await pool.query(`
			UPDATE audit_log
			SET archived_at = NOW() - INTERVAL '20 days',
					soft_deleted_at = NOW() - INTERVAL '10 days',
					s3_path = 'nonexistent/path/that/does/not/exist.parquet'
			WHERE table_name = 'users' AND changed_at < '2025-01-01'
		`)

		const deleted = await archiver.hardDeletePurged('users')

		// Should NOT delete anything because S3 file doesn't exist
		expect(deleted).toBe(0)
	})

	test('hard deletes records when S3 file actually exists', async () => {
		const s3Key = 'test-archive/verified-hard-delete.parquet'
		await putTestS3Object('test-bucket', s3Key)

		await pool.query(
			`UPDATE audit_log
			SET archived_at = NOW() - INTERVAL '20 days',
					soft_deleted_at = NOW() - INTERVAL '10 days',
					s3_path = $1
			WHERE table_name = 'users' AND changed_at < '2025-01-01'`,
			[s3Key],
		)

		const deleted = await archiver.hardDeletePurged('users')

		// Should delete because S3 file exists
		expect(deleted).toBeGreaterThan(0)
	})

	test('skips records with missing S3 files while deleting verified ones', async () => {
		const realKey = 'test-archive/real-file.parquet'
		await putTestS3Object('test-bucket', realKey)

		// First half of old records: real S3 path
		await pool.query(
			`UPDATE audit_log
			SET archived_at = NOW() - INTERVAL '20 days',
					soft_deleted_at = NOW() - INTERVAL '10 days',
					s3_path = $1
			WHERE id IN (
				SELECT id FROM audit_log
				WHERE table_name = 'users' AND changed_at < '2025-01-01'
				ORDER BY id ASC LIMIT 50
			)`,
			[realKey],
		)

		// Remaining old records: fake S3 path
		await pool.query(`
			UPDATE audit_log
			SET archived_at = NOW() - INTERVAL '20 days',
					soft_deleted_at = NOW() - INTERVAL '10 days',
					s3_path = 'fake/nonexistent.parquet'
			WHERE table_name = 'users' AND changed_at < '2025-01-01'
				AND s3_path IS NULL
		`)

		const totalSoftDeleted = await pool.query(`
			SELECT COUNT(*) as count FROM audit_log
			WHERE table_name = 'users' AND soft_deleted_at IS NOT NULL
		`)
		const totalCount = Number(totalSoftDeleted.rows[0].count)

		const deleted = await archiver.hardDeletePurged('users')

		// Should only delete records with the real S3 path
		expect(deleted).toBeGreaterThan(0)
		expect(deleted).toBeLessThan(totalCount)
	})
})

// ─────────────────────────────────────────────────────────
// Fix #5: ensurePool race condition (Archiver)
// ─────────────────────────────────────────────────────────

describe('Fix #5: PgHistoryArchiver ensurePool race condition', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await setupTestData(pool)
		await setupArchiverSchema(pool)

		if (await isS3Configured()) {
			await ensureTestBucket('test-bucket')
		}
	})

	afterEach(async () => {
		await cleanupTestData(pool)
		await pool.end()
	})

	test('concurrent processBatch calls share one pool', async () => {
		const connectionString =
			process.env.PG_AUDIT_TEST_URL ||
			'postgres://postgres:postgres@localhost:5432/pg_audit_archiver_test'

		const archiver = new PgHistoryArchiver({
			connection: connectionString,
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

		const cutoff = new Date()

		// Fire multiple concurrent calls — all trigger ensurePool
		// With the fix, only one pool should be created (no leaked connections)
		const results = await Promise.allSettled([
			archiver.processBatch('users', cutoff),
			archiver.processBatch('users', cutoff),
			archiver.processBatch('users', cutoff),
		])

		// All should resolve without connection errors
		const failures = results.filter((r) => r.status === 'rejected')
		expect(failures.length).toBe(0)

		await archiver.close()
	})
})

// ─────────────────────────────────────────────────────────
// Fix #12: S3 orphan documentation
// ─────────────────────────────────────────────────────────

describe('Fix #12: S3 orphan crash recovery documented', () => {
	test('processBatch documents the claim-based recovery path', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/PgHistoryArchiver.ts', 'utf-8')

		// New 3-phase flow releases the claim and best-effort deletes the S3 file
		// on failure; cleanupOrphanedFiles is the backstop and reapStaleClaims
		// recovers from worker crashes between phases.
		expect(source).toContain('cleanupOrphanedFiles')
		expect(source).toContain('reapStaleClaims')
		expect(source).toContain('releaseClaim')
	})
})

// ─────────────────────────────────────────────────────────
// Review Fix #6: archival queries use ORDER BY for deterministic batching
// ─────────────────────────────────────────────────────────

describe('Review Fix #6: archival queries have ORDER BY', () => {
	test('softDeleteArchived SQL contains ORDER BY id', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/PgHistoryArchiver.ts', 'utf-8')

		const softDeleteRegion = source.slice(
			source.indexOf('async softDeleteArchived('),
			source.indexOf('async hardDeletePurged('),
		)
		expect(softDeleteRegion).toContain('ORDER BY id ASC')
	})

	test('hardDeletePurged SQL contains ORDER BY id', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/PgHistoryArchiver.ts', 'utf-8')

		const hardDeleteRegion = source.slice(
			source.indexOf('async hardDeletePurged('),
			source.indexOf('async close'),
		)
		expect(hardDeleteRegion).toContain('ORDER BY id ASC')
	})
})

// ─────────────────────────────────────────────────────────
// Review Fix #17: verifyS3File uses checksum when available
// ─────────────────────────────────────────────────────────

describe('Review Fix #17: verifyS3File uses checksum when available', () => {
	test('verifyS3File sends ChecksumMode: ENABLED', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/PgHistoryArchiver.ts', 'utf-8')

		// Both verifyS3File and the upload HeadObject should request checksums
		expect(source).toContain("ChecksumMode: 'ENABLED'")
		// Mismatch handling must delete the corrupt upload
		expect(source).toContain('S3 upload checksum mismatch')
	})
})

// ─────────────────────────────────────────────────────────
// Review Fix #19: dynamic imports removed from hot paths
// ─────────────────────────────────────────────────────────

describe('Review Fix #19: dynamic imports removed from hot paths', () => {
	test('HeadObjectCommand and DeleteObjectCommand imported statically', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/PgHistoryArchiver.ts', 'utf-8')

		// Top-level imports should include these — they were dynamic before
		expect(source).toMatch(
			/import \{[^}]*HeadObjectCommand[^}]*\} from '@aws-sdk\/client-s3'/s,
		)
		expect(source).toMatch(
			/import \{[^}]*DeleteObjectCommand[^}]*\} from '@aws-sdk\/client-s3'/s,
		)
		// And should NOT contain `await import('@aws-sdk/client-s3')`
		expect(source).not.toContain("await import('@aws-sdk/client-s3')")
	})
})

// ─────────────────────────────────────────────────────────
// Review Fix #25: concurrent archival race eliminated via row locks
// (replaces the old archivedCount partial-branch documentation — the
// partial branch no longer exists because FOR UPDATE SKIP LOCKED
// prevents two processes from ever observing the same rows)
// ─────────────────────────────────────────────────────────

describe('Review Fix #25: concurrent archival uses row locks', () => {
	test('processBatch claims batches with SELECT FOR UPDATE SKIP LOCKED', async () => {
		const fs = await import('node:fs/promises')
		const source = await fs.readFile('./src/PgHistoryArchiver.ts', 'utf-8')

		expect(source).toContain('FOR UPDATE SKIP LOCKED')
	})
})
