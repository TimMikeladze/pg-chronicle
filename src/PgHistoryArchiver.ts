import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DeleteObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	PutObjectCommand,
	S3Client,
} from '@aws-sdk/client-s3'
import { NodeHttpHandler } from '@smithy/node-http-handler'
import type { Pool } from 'pg'
import { consoleLogger, type Logger } from './logger'
import { writeParquet } from './parquet'
import { validateIdentifier } from './pg-history-validators'
import { setupArchiverSchema } from './schema'
import type { ArchiverConfig } from './types'

export class PgHistoryArchiver {
	private pool!: Pool
	private ownConnection: boolean
	private config: ArchiverConfig
	private s3Client: S3Client
	private pendingConnection: string | undefined
	private poolPromise: Promise<void> | null = null
	private schemaPrefix: string = '"public"'
	private schemaDetected: boolean = false
	private schemaPromise: Promise<void> | null = null
	private schemaReady: boolean = false
	private archiveSetupPromise: Promise<void> | null = null
	private logger: Logger

	constructor(config: ArchiverConfig) {
		if (!Number.isFinite(config.gracePeriod) || config.gracePeriod < 1) {
			throw new Error(
				`PgHistoryArchiver: gracePeriod must be a positive finite number (got: ${config.gracePeriod})`,
			)
		}
		this.config = config
		this.logger = config.logger ?? consoleLogger

		if (config.pool) {
			this.pool = config.pool
			this.ownConnection = false
		} else if (config.connection) {
			this.pendingConnection = config.connection
			this.ownConnection = true
		} else {
			throw new Error('PgHistoryArchiver: No connection configuration provided')
		}

		// Initialize S3 client
		// Only use path-style when a custom endpoint is set (MinIO, localstack, etc.)
		// AWS S3 deprecated path-style for new buckets after Sep 2020
		// Timeouts prevent hung uploads from blocking the advisory lock indefinitely.
		this.s3Client = new S3Client({
			region: config.s3.region || 'us-east-1',
			endpoint: config.s3.endpoint,
			credentials:
				config.s3.accessKeyId && config.s3.secretAccessKey
					? {
							accessKeyId: config.s3.accessKeyId,
							secretAccessKey: config.s3.secretAccessKey,
						}
					: undefined,
			forcePathStyle: !!config.s3.endpoint,
			requestHandler: new NodeHttpHandler({
				requestTimeout: 30_000, // 30s per S3 request
				connectionTimeout: 5_000, // 5s to establish connection
			}),
		})
	}

	private async ensurePool(): Promise<void> {
		if (!this.pool) {
			if (!this.poolPromise) {
				this.poolPromise = (async () => {
					if (!this.pendingConnection) return
					const pg = await import('pg')
					this.pool = new pg.default.Pool({
						connectionString: this.pendingConnection,
					})
					this.pendingConnection = undefined
				})().catch((err) => {
					// Reset so the next call retries instead of re-awaiting the rejection
					this.poolPromise = null
					throw err
				})
			}
			await this.poolPromise
		}
		// Detect schema on first pool use — dedup concurrent callers with a promise.
		if (!this.schemaDetected && this.pool) {
			if (!this.schemaPromise) {
				this.schemaPromise = (async () => {
					const result = await this.pool.query(
						'SELECT current_schema() as schema',
					)
					const schema = result.rows[0]?.schema || 'public'
					validateIdentifier(schema, 'schema')
					this.schemaPrefix = `"${schema}"`
					this.schemaDetected = true
				})().finally(() => {
					this.schemaPromise = null
				})
			}
			await this.schemaPromise
		}
	}

	/**
	 * Initialize the archiver schema — adds `archived_at`, `s3_path`, and
	 * `soft_deleted_at` columns to `audit_log` and creates the
	 * `audit_archive_metadata` and `audit_archival_stats` tables.
	 *
	 * Must be called once before `processBatch()`, `softDeleteArchived()`,
	 * `hardDeletePurged()`, or `cleanupOrphanedFiles()`. Safe to call
	 * concurrently — only one DDL run executes at a time.
	 */
	async setup(): Promise<void> {
		if (this.schemaReady) return
		if (this.archiveSetupPromise) return this.archiveSetupPromise

		this.archiveSetupPromise = (async () => {
			await this.ensurePool()
			await setupArchiverSchema(this.pool)
			this.schemaReady = true
		})().finally(() => {
			if (!this.schemaReady) this.archiveSetupPromise = null
		})

		return this.archiveSetupPromise
	}

	private ensureSchemaReady(): void {
		if (!this.schemaReady) {
			throw new Error(
				'PgHistoryArchiver: Schema not initialized. ' +
					'Call await archiver.setup() before using this method. ' +
					'This ensures the archived_at, s3_path, and soft_deleted_at columns exist on audit_log.',
			)
		}
	}

	private get auditTable(): string {
		return `${this.schemaPrefix}."audit_log"`
	}

	private get metadataTable(): string {
		return `${this.schemaPrefix}."audit_archive_metadata"`
	}

	/**
	 * Generate S3 path with Hive partitioning
	 */
	generateS3Path(tableName: string, date: Date): string {
		validateIdentifier(tableName, 'table')
		const year = date.getFullYear()
		const month = String(date.getMonth() + 1).padStart(2, '0')
		const day = String(date.getDate()).padStart(2, '0')
		const uuid = randomUUID()

		return `${tableName}/year=${year}/month=${month}/day=${day}/data-${uuid}.parquet`
	}

	/**
	 * Upload batch of records to S3 as Parquet file.
	 * Returns both the S3 path and the base64-encoded SHA-256 checksum that
	 * was sent to S3 — callers use the checksum to verify byte-level integrity
	 * via HeadObject with ChecksumMode=ENABLED.
	 */
	async uploadBatchToS3(
		records: Array<Record<string, unknown>>,
		tableName: string,
		date: Date,
	): Promise<{ s3Path: string; sha256: string }> {
		// Write to a restricted temp directory to prevent data exposure on shared hosts
		const tmpDir = await mkdtemp(join(tmpdir(), 'pg-history-'))
		await chmod(tmpDir, 0o700)
		const tmpFile = join(tmpDir, 'data.parquet')

		try {
			await writeParquet(records, tmpFile)

			// Generate S3 path
			const s3Path = this.generateS3Path(tableName, date)

			// Read file and compute SHA-256 checksum for integrity verification
			const fileContent = await readFile(tmpFile)
			const sha256 = createHash('sha256').update(fileContent).digest('base64')

			const command = new PutObjectCommand({
				Bucket: this.config.s3.bucket,
				Key: s3Path,
				Body: fileContent,
				ContentLength: fileContent.length,
				ChecksumSHA256: sha256,
			})

			await this.s3Client.send(command)

			return { s3Path, sha256 }
		} finally {
			// Cleanup temp directory and file
			try {
				await rm(tmpDir, { recursive: true })
			} catch (err) {
				this.logger.warn('Failed to remove temp directory after upload', {
					tmpDir,
					err,
				})
			}
		}
	}

	/**
	 * Process a single batch concurrently-safe:
	 * 1. BEGIN transaction, peek earliest unarchived changed_at
	 * 2. SELECT FOR UPDATE SKIP LOCKED — claim a batch of rows exclusively
	 *    so concurrent archival runs never see the same IDs
	 * 3. Upload Parquet to S3 while holding row locks
	 * 4. UPDATE archived_at / s3_path on the claimed rows, INSERT metadata
	 * 5. COMMIT (releases locks)
	 *
	 * Holding the transaction across the S3 upload is intentional: it
	 * guarantees no two archival processes can ever write overlapping record
	 * IDs into separate Parquet files. S3 uploads are bounded by the 30s
	 * request timeout configured on the client, so the lock hold is bounded.
	 *
	 * Crash recovery:
	 * - Before COMMIT: transaction rolls back, locks release, rows remain
	 *   unarchived. The S3 file (if uploaded) becomes an orphan that
	 *   cleanupOrphanedFiles() will sweep up.
	 * - After COMMIT: rows marked archived, safe.
	 */
	async processBatch(
		tableName: string,
		cutoffDate: Date,
	): Promise<BatchResult> {
		this.ensureSchemaReady()
		await this.ensurePool()
		const batchSize = this.config.batchSize || 10000

		const client = await this.pool.connect()
		let s3Path = ''
		let uploadedToS3 = false
		let committed = false

		try {
			await client.query('BEGIN')

			// Step 1: Find the earliest unarchived date for this table.
			// No FOR UPDATE here — this is just to pick a day boundary.
			const peekResult = await client.query(
				`SELECT changed_at
        FROM ${this.auditTable}
        WHERE table_name = $1
          AND changed_at < $2
          AND archived_at IS NULL
        ORDER BY changed_at ASC
        LIMIT 1`,
				[tableName, cutoffDate],
			)

			if (peekResult.rows.length === 0) {
				await client.query('ROLLBACK')
				return {
					recordCount: 0,
					fileSize: 0,
					s3Path: '',
					status: 'completed',
				}
			}

			const date = new Date(peekResult.rows[0].changed_at as Date)
			// Compute next day boundary in UTC so each file covers exactly one calendar day
			const dayStart = new Date(
				Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
			)
			const dayEnd = new Date(dayStart)
			dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)

			// Step 2: Atomically claim a batch of rows with SELECT FOR UPDATE
			// SKIP LOCKED. Rows already locked by a concurrent archival run are
			// skipped, so two processes never observe the same IDs. Snapshot is
			// implicit in the transaction's MVCC view, so no explicit NOW() cutoff
			// is needed.
			const result = await client.query(
				`SELECT
          id,
          table_name,
          record_id,
          operation,
          changed_at,
          old_data,
          new_data
        FROM ${this.auditTable}
        WHERE table_name = $1
          AND changed_at >= $2
          AND changed_at < $3
          AND archived_at IS NULL
        ORDER BY changed_at ASC
        LIMIT $4
        FOR UPDATE SKIP LOCKED`,
				[tableName, dayStart, dayEnd, batchSize],
			)

			const records = result.rows as Array<Record<string, unknown>>

			if (records.length === 0) {
				await client.query('ROLLBACK')
				return {
					recordCount: 0,
					fileSize: 0,
					s3Path: '',
					status: 'completed',
				}
			}

			// Step 3: Upload to S3 while holding row locks. This is the expensive
			// part of the transaction — bounded by the NodeHttpHandler timeout.
			const uploaded = await this.uploadBatchToS3(records, tableName, date)
			s3Path = uploaded.s3Path
			const sha256 = uploaded.sha256
			uploadedToS3 = true

			// Verify upload succeeded AND checksum matches what we sent
			const headCommand = new HeadObjectCommand({
				Bucket: this.config.s3.bucket,
				Key: s3Path,
				ChecksumMode: 'ENABLED',
			})
			const headResult = await this.s3Client.send(headCommand)
			const fileSize = headResult.ContentLength || 0

			if (!fileSize || fileSize === 0) {
				throw new Error(`S3 upload verification failed: ${s3Path}`)
			}

			// Verify the checksum echoed back by S3 matches what we computed locally.
			// Not all S3-compatible stores return checksums — we only fail if they do
			// and it doesn't match.
			const returnedChecksum = headResult.ChecksumSHA256
			if (returnedChecksum && returnedChecksum !== sha256) {
				throw new Error(
					`S3 upload checksum mismatch for ${s3Path}: expected ${sha256}, got ${returnedChecksum}`,
				)
			}

			// Step 4: Mark claimed rows as archived. Because we hold row locks,
			// no concurrent process can race us here.
			// Note: records come from pg-js with BIGINT as string by default; ANY
			// accepts a JS array of string ids for bigint[] with an explicit cast.
			const recordIds = records.map((r) => r.id)
			const updateResult = await client.query(
				`UPDATE ${this.auditTable}
         SET archived_at = NOW(),
             s3_path = $2
         WHERE id = ANY($1::bigint[])
           AND archived_at IS NULL
         RETURNING id`,
				[recordIds, s3Path],
			)

			const archivedCount = updateResult.rowCount || 0

			// Record metadata (idempotent with UNIQUE constraint)
			const archiveDate = date.toISOString().split('T')[0]
			await client.query(
				`INSERT INTO ${this.metadataTable} (
          table_name, archive_date, s3_path, record_count, file_size
        ) VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (s3_path) DO NOTHING`,
				[tableName, archiveDate, s3Path, records.length, fileSize],
			)

			await client.query('COMMIT')
			committed = true

			return {
				recordCount: archivedCount,
				fileSize,
				s3Path,
				status: 'completed',
			}
		} catch (err) {
			if (!committed) {
				await client.query('ROLLBACK').catch(() => {})
			}
			// If we uploaded to S3 but did not commit, the file is now orphaned.
			// Best-effort delete; cleanupOrphanedFiles() is the backstop.
			if (uploadedToS3 && s3Path && !committed) {
				await this.s3Client
					.send(
						new DeleteObjectCommand({
							Bucket: this.config.s3.bucket,
							Key: s3Path,
						}),
					)
					.catch(() => {
						this.logger.warn(
							'Failed to clean up orphaned S3 file after transaction rollback',
							{ s3Path },
						)
					})
			}
			throw err
		} finally {
			client.release()
		}
	}

	/**
	 * Verify S3 file exists and (if possible) that its checksum matches
	 * what we recorded in the metadata table.
	 */
	private async verifyS3File(
		s3Path: string,
		expectedChecksum?: string,
	): Promise<boolean> {
		try {
			const command = new HeadObjectCommand({
				Bucket: this.config.s3.bucket,
				Key: s3Path,
				ChecksumMode: 'ENABLED',
			})
			const result = await this.s3Client.send(command)
			// If caller provided an expected checksum and S3 returned one, compare.
			// If S3 doesn't echo a checksum (some storage backends), fall back to
			// existence check.
			if (expectedChecksum && result.ChecksumSHA256) {
				return result.ChecksumSHA256 === expectedChecksum
			}
			return true
		} catch (_error) {
			return false
		}
	}

	/**
	 * Scan S3 for orphaned parquet files — files uploaded during a failed
	 * archival run that never got recorded in audit_archive_metadata.
	 *
	 * This is an idempotent best-effort cleanup routine. Call it from a scheduled
	 * job or on-demand. It lists every parquet under the table prefix and removes
	 * anything that isn't referenced in audit_archive_metadata.
	 *
	 * Returns the number of orphans deleted.
	 */
	async cleanupOrphanedFiles(tableName: string): Promise<number> {
		this.ensureSchemaReady()
		validateIdentifier(tableName, 'table')
		await this.ensurePool()

		// List S3 objects page by page and do a point-lookup per key against the
		// database instead of loading all metadata paths into memory.  This keeps
		// memory usage O(page-size) regardless of how many archived files exist.
		let continuationToken: string | undefined
		let orphanCount = 0

		do {
			const listCommand = new ListObjectsV2Command({
				Bucket: this.config.s3.bucket,
				Prefix: `${tableName}/`,
				ContinuationToken: continuationToken,
			})
			const listResult = await this.s3Client.send(listCommand)

			// Collect parquet keys for this page
			const pageKeys = (listResult.Contents || [])
				.map((obj) => obj.Key)
				.filter((key): key is string => !!key && key.endsWith('.parquet'))

			if (pageKeys.length > 0) {
				// Batch lookup: one query per page instead of one query per key (avoids N+1)
				const knownResult = await this.pool.query(
					`SELECT s3_path FROM ${this.metadataTable}
					WHERE s3_path = ANY($1::text[]) AND table_name = $2`,
					[pageKeys, tableName],
				)
				const knownPaths = new Set<string>(
					knownResult.rows.map((r: { s3_path: string }) => r.s3_path),
				)

				for (const key of pageKeys) {
					if (knownPaths.has(key)) continue

					// Orphan — delete it
					try {
						await this.s3Client.send(
							new DeleteObjectCommand({
								Bucket: this.config.s3.bucket,
								Key: key,
							}),
						)
						orphanCount++
						this.logger.info('Deleted orphaned S3 file', { s3Path: key })
					} catch (err) {
						this.logger.warn('Failed to delete orphaned S3 file', {
							s3Path: key,
							err,
						})
					}
				}
			}

			continuationToken = listResult.NextContinuationToken
		} while (continuationToken)

		return orphanCount
	}

	/**
	 * Soft delete archived records past grace period in batches.
	 * ONLY if s3_path is set (proof of backup).
	 * Uses a subquery with LIMIT to avoid locking millions of rows at once.
	 * Orders by id ASC for deterministic oldest-first batch progression.
	 */
	async softDeleteArchived(tableName: string): Promise<number> {
		this.ensureSchemaReady()
		await this.ensurePool()
		const batchSize = this.config.batchSize || 10000

		// Use the database server's NOW() for cutoff calculation — consistent with
		// processBatch which also uses the DB clock to avoid application/DB clock skew.
		const result = await this.pool.query(
			`UPDATE ${this.auditTable}
      SET soft_deleted_at = NOW()
      WHERE id IN (
        SELECT id FROM ${this.auditTable}
        WHERE table_name = $1
          AND archived_at IS NOT NULL
          AND archived_at < NOW() - ($2 * INTERVAL '1 day')
          AND soft_deleted_at IS NULL
          AND s3_path IS NOT NULL
        ORDER BY id ASC
        LIMIT $3
      )`,
			[tableName, this.config.gracePeriod, batchSize],
		)

		return result.rowCount || 0
	}

	/**
	 * Hard delete soft-deleted records past grace period.
	 *
	 * Algorithm:
	 *   1. Select candidate records (soft-deleted past grace period with s3_path)
	 *   2. Verify each S3 file exists (bounded parallel HeadObject requests)
	 *   3. Inside a transaction: lock verified rows FOR UPDATE, re-verify their
	 *      s3_path is still set (guards against concurrent UPDATE that cleared it),
	 *      then DELETE.
	 *
	 * The transaction with row locking closes the TOCTOU window: between the
	 * S3 verification and the DELETE, another process cannot alter the rows'
	 * s3_path because we hold row-level locks.
	 */
	async hardDeletePurged(tableName: string): Promise<number> {
		this.ensureSchemaReady()
		await this.ensurePool()

		// Step 1: Get candidate records with their S3 paths.
		// Only select records that have an s3_path (proof of backup).
		// Records without s3_path should not have been soft-deleted,
		// but if they were, we skip them to avoid data loss.
		// Order by id ASC so hard-delete progress is deterministic (oldest first).
		// Use database NOW() for clock-skew safety (consistent with processBatch).
		const batchSize = this.config.batchSize || 10000
		const checkResult = await this.pool.query(
			`SELECT id, s3_path
      FROM ${this.auditTable}
      WHERE table_name = $1
        AND soft_deleted_at IS NOT NULL
        AND soft_deleted_at < NOW() - ($2 * INTERVAL '1 day')
        AND s3_path IS NOT NULL
      ORDER BY id ASC
      LIMIT $3`,
			[tableName, this.config.gracePeriod, batchSize],
		)

		if (checkResult.rows.length === 0) {
			return 0
		}

		// Step 2: Verify S3 files per-path, collecting verified paths.
		const s3Paths = new Set<string>()
		for (const row of checkResult.rows) {
			if (row.s3_path) {
				s3Paths.add(row.s3_path)
			}
		}

		const verifiedPaths = new Set<string>()

		// Verify S3 paths in parallel (bounded concurrency)
		const CONCURRENCY = 10
		const pathArray = [...s3Paths]

		for (let i = 0; i < pathArray.length; i += CONCURRENCY) {
			const batch = pathArray.slice(i, i + CONCURRENCY)
			const results = await Promise.all(
				batch.map(async (s3Path) => {
					const exists = await this.verifyS3File(s3Path)
					return { s3Path, exists }
				}),
			)

			for (const { s3Path, exists } of results) {
				if (exists) {
					verifiedPaths.add(s3Path)
				} else {
					this.logger.warn('S3 file missing, skipping records with this path', {
						s3Path,
					})
				}
			}
		}

		// Only delete records whose S3 path is verified
		const candidateIds = checkResult.rows
			.filter((r) => r.s3_path && verifiedPaths.has(r.s3_path))
			.map((r) => r.id)

		if (candidateIds.length === 0) {
			return 0
		}

		// Step 3: Lock rows FOR UPDATE inside a transaction and re-verify
		// s3_path is still set before deleting. This closes the TOCTOU window
		// between the SELECT above and the DELETE below — another process
		// cannot alter these rows while we hold the lock.
		const client = await this.pool.connect()
		try {
			await client.query('BEGIN')

			// SELECT FOR UPDATE locks the rows. Re-filter by the exact verified s3_path
			// values (not just IS NOT NULL) to close the TOCTOU window where the path
			// could have changed between the outer SELECT and this lock.
			const verifiedPathsArray = Array.from(verifiedPaths)
			const lockResult = await client.query(
				`SELECT id FROM ${this.auditTable}
        WHERE id = ANY($1::bigint[])
          AND s3_path = ANY($2::text[])
          AND soft_deleted_at IS NOT NULL
        ORDER BY id ASC
        FOR UPDATE`,
				[candidateIds, verifiedPathsArray],
			)

			const lockedIds = lockResult.rows.map((r: { id: string }) => r.id)
			if (lockedIds.length === 0) {
				await client.query('ROLLBACK')
				return 0
			}

			// Re-check s3_path IS NOT NULL in the DELETE itself as a final safety guard.
			// The FOR UPDATE lock prevents concurrent modification of these rows, but
			// this guard ensures no row without a confirmed backup is ever hard-deleted.
			const deleteResult = await client.query(
				`DELETE FROM ${this.auditTable}
        WHERE id = ANY($1::bigint[])
          AND s3_path IS NOT NULL`,
				[lockedIds],
			)

			await client.query('COMMIT')
			return deleteResult.rowCount || 0
		} catch (err) {
			await client.query('ROLLBACK').catch(() => {})
			throw err
		} finally {
			client.release()
		}
	}

	async close(): Promise<void> {
		if (this.ownConnection && this.pool) {
			await this.pool.end()
		}
	}
}

interface BatchResult {
	recordCount: number
	fileSize: number
	s3Path: string
	status: 'completed' | 'failed'
	errorMessage?: string
}
