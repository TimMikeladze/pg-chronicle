/**
 * Regression tests for the archiver gaps found in the 2026-08 audit:
 * attribution lost on archive, a read path that did not exist, a batch loop
 * that quit on contention, maintenance that nothing scheduled, and a schema
 * setup that raced itself.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { Pool } from 'pg'
import { Orchestrator } from '../../src/orchestrator'
import { PgChronicleArchiver } from '../../src/PgChronicleArchiver'
import { setupArchiverSchema } from '../../src/schema'
import { cleanupTestData, getTestConnection, setupTestData } from './helpers/db'
import { ensureTestBucket, isS3Configured, putTestS3Object } from './helpers/s3'

const BUCKET = 'test-bucket'

/**
 * The orchestrator's advisory-lock client is standalone, and without an explicit
 * string it reads pg's private pool options — which the test pool does not
 * populate in a way it can use.
 */
const LOCK_CONNECTION_STRING =
	'postgres://postgres:postgres@localhost:5432/pg_chronicle_archiver_test'

const S3_CONFIG = {
	bucket: BUCKET,
	endpoint: process.env.PG_CHRONICLE_S3_ENDPOINT,
	accessKeyId: process.env.PG_CHRONICLE_S3_ACCESS_KEY_ID,
	secretAccessKey: process.env.PG_CHRONICLE_S3_SECRET_ACCESS_KEY,
	region: process.env.PG_CHRONICLE_S3_REGION,
}

function s3Client(): S3Client {
	return new S3Client({
		endpoint: process.env.PG_CHRONICLE_S3_ENDPOINT,
		region: process.env.PG_CHRONICLE_S3_REGION || 'us-east-1',
		credentials: {
			accessKeyId: process.env.PG_CHRONICLE_S3_ACCESS_KEY_ID || 'root',
			secretAccessKey:
				process.env.PG_CHRONICLE_S3_SECRET_ACCESS_KEY || 'password',
		},
		forcePathStyle: true,
	})
}

function cutoff(daysAgo = 90): Date {
	const date = new Date()
	date.setDate(date.getDate() - daysAgo)
	return date
}

describe('archiver gaps', () => {
	let pool: Pool
	let archiver: PgChronicleArchiver
	let s3Ready = false

	beforeEach(async () => {
		pool = await getTestConnection()
		await setupTestData(pool)
		await setupArchiverSchema(pool)
		s3Ready = await isS3Configured()
		if (s3Ready) await ensureTestBucket(BUCKET)

		archiver = new PgChronicleArchiver({
			pool,
			s3: S3_CONFIG,
			retention: { default: 90 },
			gracePeriod: 7,
			batchSize: 10,
		})
	})

	afterEach(async () => {
		await cleanupTestData(pool)
		await pool.end()
	})

	/**
	 * The archive used to carry only id/table/record/operation/timestamp/data.
	 * Once a row is hard-deleted the Parquet file is the last copy, so dropping
	 * db_user / app_actor / client_addr destroyed the answer to "who did this".
	 */
	test('archived Parquet keeps the attribution columns', async () => {
		if (!s3Ready) return

		const result = await archiver.processBatch('users', cutoff())
		expect(result.status).toBe('completed')
		expect(result.recordCount).toBeGreaterThan(0)

		const rows = await archiver.readArchive(result.s3Path)
		expect(rows.length).toBe(result.recordCount)

		const first = rows[0]
		expect(first).toBeDefined()
		expect(first?.db_user).toBe('app_role')
		expect(first?.app_actor).toBe('user-42')
		expect(first?.client_addr).toBe('203.0.113.7')
	})

	/** There was no way to read an archive back through the library at all. */
	test('listArchives indexes what readArchive can fetch', async () => {
		if (!s3Ready) return

		const written = await archiver.processBatch('users', cutoff())
		const archives = await archiver.listArchives('users')

		expect(archives.length).toBeGreaterThan(0)
		const entry = archives.find((a) => a.s3Path === written.s3Path)
		expect(entry).toBeDefined()
		expect(entry?.recordCount).toBe(written.recordCount)
		expect(entry?.tableName).toBe('users')

		const rows = await archiver.readArchive(entry?.s3Path ?? '')
		expect(rows.length).toBe(written.recordCount)
	})

	/**
	 * `archive_date` is a DATE holding a UTC calendar day. Handing PG a raw
	 * timestamptz let it resolve the bound in the session time zone, shifting the
	 * window by a day for anyone not on UTC.
	 */
	test('listArchives date bounds are UTC calendar days', async () => {
		if (!s3Ready) return

		// The seeded rows are all dated 2024-01-15 (UTC).
		await archiver.processBatch('users', cutoff())

		const onTheDay = await archiver.listArchives('users', {
			from: new Date('2024-01-15T00:00:00Z'),
			to: new Date('2024-01-15T23:59:59Z'),
		})
		expect(onTheDay.length).toBeGreaterThan(0)

		// A late-evening bound in a west-of-UTC zone still means "that UTC day".
		const lateEvening = await archiver.listArchives('users', {
			from: new Date('2024-01-15T23:30:00Z'),
		})
		expect(lateEvening.length).toBe(onTheDay.length)

		const after = await archiver.listArchives('users', {
			from: new Date('2024-01-16T00:00:00Z'),
		})
		expect(after.length).toBe(0)
	})

	test('readArchive refuses an object whose bytes no longer match', async () => {
		if (!s3Ready) return

		const written = await archiver.processBatch('users', cutoff())
		// Overwrite the archived object with different bytes, leaving the metadata
		// row (and its checksum) untouched — the tampering case.
		await putTestS3Object(BUCKET, written.s3Path)

		await expect(archiver.readArchive(written.s3Path)).rejects.toThrow(
			/checksum mismatch/,
		)
	})

	/**
	 * Nothing eligible at all is the one case that genuinely means "table done".
	 */
	test('an empty table reports completed with no records', async () => {
		await pool.query(
			`UPDATE audit_log SET archived_at = NOW(), s3_path = 'x'
			 WHERE table_name = 'users' AND changed_at < $1`,
			[cutoff()],
		)

		const result = await archiver.processBatch('users', cutoff())
		expect(result.recordCount).toBe(0)
		expect(result.status).toBe('completed')
	})

	/**
	 * The bug: a concurrent archiver claiming the rows between our peek and our
	 * claim made processBatch report `completed` with zero records, which the
	 * orchestrator read as "table done" — abandoning the rest of the backlog.
	 *
	 * Reproduced by interposing on the claim connection: the moment the peek
	 * returns, a competitor (on its own pool, so pg's callback-style
	 * `pool.query` is untouched) claims every candidate row.
	 */
	test('losing the claim race reports contended, not completed', async () => {
		const competitorPool = await getTestConnection()
		const realConnect = pool.connect.bind(pool)
		let stolen = false

		// biome-ignore lint/suspicious/noExplicitAny: narrow test seam over pg's overloads
		const patched = pool as any

		// biome-ignore lint/suspicious/noExplicitAny: pg client type
		const instrument = (client: any) => {
			const clientQuery = client.query.bind(client)
			// biome-ignore lint/suspicious/noExplicitAny: pg's query overloads
			client.query = async (...args: any[]) => {
				// biome-ignore lint/suspicious/noExplicitAny: pg's query overloads
				const result = await (clientQuery as any)(...args)
				const sql = typeof args[0] === 'string' ? args[0] : ''
				const isPeek =
					sql.includes('ORDER BY changed_at ASC') && sql.includes('LIMIT 1')
				if (!stolen && isPeek) {
					stolen = true
					await competitorPool.query(
						`UPDATE audit_log
						 SET claim_id = gen_random_uuid(), claimed_at = NOW()
						 WHERE table_name = 'users' AND archived_at IS NULL AND claim_id IS NULL`,
					)
				}
				return result
			}
			return client
		}

		// Must honour BOTH call styles: application code awaits connect(), but
		// pg's own `pool.query` calls `connect(callback)` internally. A
		// promise-only override silently strands every pool.query in the process.
		// biome-ignore lint/suspicious/noExplicitAny: pg's connect overloads
		patched.connect = (cb?: (err: any, client?: any, done?: any) => void) => {
			const promise = realConnect().then(instrument)
			if (typeof cb !== 'function') return promise
			promise.then(
				(client) => cb(undefined, client, () => client.release()),
				(err) => cb(err),
			)
			return undefined
		}

		try {
			const result = await archiver.processBatch('users', cutoff())
			expect(stolen).toBe(true)
			expect(result.recordCount).toBe(0)
			expect(result.status).toBe('contended')
		} finally {
			patched.connect = realConnect
			await competitorPool.end()
		}
	})
})

describe('orchestrator maintenance and knob forwarding', () => {
	let pool: Pool
	let s3Ready = false

	beforeEach(async () => {
		pool = await getTestConnection()
		await setupTestData(pool)
		await setupArchiverSchema(pool)
		s3Ready = await isS3Configured()
		if (s3Ready) await ensureTestBucket(BUCKET)
	})

	afterEach(async () => {
		await cleanupTestData(pool)
		await pool.end()
	})

	/**
	 * maxBatchBytes was declared on ArchiverConfig but the orchestrator never
	 * passed it on, so no server-hosted archiver could change it. A tiny cap must
	 * now visibly split one day's rows across several files.
	 */
	test('maxBatchBytes reaches the archiver the orchestrator creates', async () => {
		if (!s3Ready) return

		const orchestrator = new Orchestrator({
			s3: S3_CONFIG,
			retention: { default: 90 },
			gracePeriod: 7,
			batchSize: 100,
			// Small enough that the 100 same-day rows cannot fit in one batch.
			maxBatchBytes: 600,
			lockConnectionString: LOCK_CONNECTION_STRING,
		})

		const stats = await orchestrator.run(pool, { targetTable: 'users' })
		expect(stats.errors).toEqual([])
		expect(stats.totalRecordsArchived).toBeGreaterThan(0)

		const files = await pool.query(
			`SELECT COUNT(*)::int AS count FROM audit_archive_metadata WHERE table_name = 'users'`,
		)
		// One batch would have produced exactly one file.
		expect(files.rows[0].count).toBeGreaterThan(1)
	})

	/**
	 * cleanupOrphanedFiles existed but nothing ever called it, so debris from
	 * failed runs accumulated forever unless the operator wrote their own job.
	 */
	test('cleanupOrphans removes files no metadata row references', async () => {
		if (!s3Ready) return

		// Debris of the shape a run that uploaded and then failed leaves behind:
		// an object under the table prefix with no metadata row pointing at it.
		const orphanKey = 'users/year=2024/month=01/day=15/data-orphan.parquet'
		await putTestS3Object(BUCKET, orphanKey)

		const orchestrator = new Orchestrator({
			s3: S3_CONFIG,
			retention: { default: 90 },
			gracePeriod: 7,
			batchSize: 100,
			lockConnectionString: LOCK_CONNECTION_STRING,
		})

		const stats = await orchestrator.run(pool, {
			targetTable: 'users',
			// minAgeMinutes: 0 — the in-flight safety window normally protects an
			// object this young, and a test cannot age one.
			cleanupOrphans: { minAgeMinutes: 0 },
		})
		expect(stats.errors).toEqual([])
		expect(stats.totalOrphanFilesDeleted).toBeGreaterThan(0)

		// The orphan is gone; the files this run legitimately wrote are not.
		await expect(
			s3Client().send(
				new HeadObjectCommand({ Bucket: BUCKET, Key: orphanKey }),
			),
		).rejects.toBeDefined()

		const kept = await pool.query(
			`SELECT s3_path FROM audit_archive_metadata WHERE table_name = 'users' LIMIT 1`,
		)
		expect(kept.rows.length).toBeGreaterThan(0)
		const stillThere = await s3Client().send(
			new HeadObjectCommand({ Bucket: BUCKET, Key: kept.rows[0].s3_path }),
		)
		expect(stillThere.ContentLength).toBeGreaterThan(0)
	})
})

describe('setupArchiverSchema is safe to run concurrently', () => {
	let pool: Pool

	beforeEach(async () => {
		pool = await getTestConnection()
		await setupTestData(pool)
	})

	afterEach(async () => {
		await cleanupTestData(pool)
		await pool.end()
	})

	/**
	 * Two replicas booting together both missed the fast path and raced on
	 * CREATE INDEX CONCURRENTLY / ATTACH PARTITION. An advisory lock now
	 * serializes them.
	 */
	test('parallel setups all succeed', async () => {
		const results = await Promise.allSettled([
			setupArchiverSchema(pool),
			setupArchiverSchema(pool),
			setupArchiverSchema(pool),
		])

		const failures = results.filter((r) => r.status === 'rejected')
		expect(failures).toEqual([])

		const columns = await pool.query(
			`SELECT COUNT(*)::int AS count FROM information_schema.columns
			 WHERE table_schema = current_schema() AND table_name = 'audit_log'
			   AND column_name IN ('archived_at','s3_path','soft_deleted_at','claim_id','claimed_at')`,
		)
		expect(columns.rows[0].count).toBe(5)
	})
})
