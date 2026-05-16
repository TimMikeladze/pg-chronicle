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
import {
	attachPoolErrorHandler,
	consoleLogger,
	endPoolWithTimeout,
	type Logger,
} from './logger'
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
			attachPoolErrorHandler(this.pool, this.logger, 'Archiver')
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
					attachPoolErrorHandler(this.pool, this.logger, 'Archiver')
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

	private async ensureSchemaReady(): Promise<void> {
		if (this.schemaReady) return
		await this.setup()
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
		// UTC components only — processBatch builds dayStart/dayEnd via
		// Date.UTC(...), so partition path must match or rows from the same
		// UTC day land in different Hive partitions when the server's TZ
		// isn't UTC.
		const year = date.getUTCFullYear()
		const month = String(date.getUTCMonth() + 1).padStart(2, '0')
		const day = String(date.getUTCDate()).padStart(2, '0')
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
	 * Process a single batch in three short transactions, releasing row locks
	 * across the slow S3 upload so concurrent archivers and ordinary writers do
	 * not block.
	 *
	 * 1. CLAIM (TX1, ms): atomically tag a batch of unarchived rows with a
	 *    fresh claim_id via UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED).
	 *    COMMIT releases the row locks immediately. Other archivers skip these
	 *    rows by predicate (claim_id IS NOT NULL), not by lock contention.
	 *
	 * 2. UPLOAD (no TX): write Parquet to S3 and verify with HeadObject. No
	 *    database lock is held during the upload — concurrent archivers can
	 *    claim disjoint batches in parallel.
	 *
	 * 3. FINALIZE (TX2, ms): UPDATE archived_at / s3_path on claim-id rows
	 *    and INSERT metadata. COMMIT.
	 *
	 * Failure handling:
	 * - Upload or finalize failure releases the claim (claim_id := NULL) so the
	 *   batch is eligible to be reclaimed on the next run, and best-effort
	 *   deletes the S3 file (cleanupOrphanedFiles is the backstop).
	 * - Worker crash between TX1 and TX2 leaves a stale claim. reapStaleClaims()
	 *   resets claims older than staleClaimMinutes so the rows return to the
	 *   pending pool. Run it on a schedule or at the start of each archival run.
	 */
	async processBatch(
		tableName: string,
		cutoffDate: Date,
	): Promise<BatchResult> {
		await this.ensureSchemaReady()
		await this.ensurePool()
		const batchSize = this.config.batchSize || 10000
		const claimId = randomUUID()

		// Phase 1: claim rows in a brief transaction. Locks released on COMMIT
		// before any S3 I/O — concurrent archivers SKIP LOCKED only during this
		// short window, then partition by claim_id for the rest of the work.
		const claimClient = await this.pool.connect()
		let date: Date
		let records: Array<Record<string, unknown>>
		try {
			await claimClient.query('BEGIN')
			// SET LOCAL scopes the timeout to this transaction only; reverts
			// automatically on COMMIT/ROLLBACK so the connection returns to the
			// pool clean. 60s is comfortable for the indexed scan + UPDATE on a
			// healthy partition; queries slower than this point to missing index
			// or table bloat that needs operator attention, not silent waiting.
			await claimClient.query('SET LOCAL statement_timeout = 60000')

			// Find the earliest unclaimed/unarchived date for this table to pick a
			// day boundary so each Parquet file covers exactly one calendar day.
			const peekResult = await claimClient.query(
				`SELECT changed_at
        FROM ${this.auditTable}
        WHERE table_name = $1
          AND changed_at < $2
          AND archived_at IS NULL
          AND claim_id IS NULL
        ORDER BY changed_at ASC
        LIMIT 1`,
				[tableName, cutoffDate],
			)

			if (peekResult.rows.length === 0) {
				await claimClient.query('ROLLBACK')
				return {
					recordCount: 0,
					fileSize: 0,
					s3Path: '',
					status: 'completed',
				}
			}

			date = new Date(peekResult.rows[0].changed_at as Date)
			const dayStart = new Date(
				Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
			)
			const dayEnd = new Date(dayStart)
			dayEnd.setUTCDate(dayEnd.getUTCDate() + 1)

			// Atomic claim: SELECT ... FOR UPDATE SKIP LOCKED inside the UPDATE
			// subquery causes concurrent claimants to skip rows briefly held by
			// this transaction. The UPDATE sets claim_id, which subsequent calls
			// filter out by predicate even after we COMMIT.
			const claimResult = await claimClient.query(
				`UPDATE ${this.auditTable} a
        SET claim_id = $5, claimed_at = NOW()
        FROM (
          SELECT id FROM ${this.auditTable}
          WHERE table_name = $1
            AND changed_at >= $2
            AND changed_at < $3
            AND archived_at IS NULL
            AND claim_id IS NULL
          ORDER BY changed_at ASC
          LIMIT $4
          FOR UPDATE SKIP LOCKED
        ) picked
        WHERE a.id = picked.id
        RETURNING a.id, a.table_name, a.record_id, a.operation,
                  a.changed_at, a.old_data, a.new_data`,
				[tableName, dayStart, dayEnd, batchSize, claimId],
			)

			records = claimResult.rows as Array<Record<string, unknown>>

			if (records.length === 0) {
				await claimClient.query('ROLLBACK')
				return {
					recordCount: 0,
					fileSize: 0,
					s3Path: '',
					status: 'completed',
				}
			}

			// Soft byte cap: estimate per-row size from JSON length of old_data/
			// new_data and trim the tail once cumulative size crosses the limit.
			// Trimmed rows have their claim released here (inside the same TX)
			// so they reappear in the next run without waiting for the reaper.
			const maxBatchBytes = this.config.maxBatchBytes ?? 256 * 1024 * 1024
			let cumulative = 0
			let cutoffIdx = records.length
			for (let i = 0; i < records.length; i++) {
				const r = records[i]
				if (!r) continue
				const oldSize = r.old_data ? JSON.stringify(r.old_data).length : 0
				const newSize = r.new_data ? JSON.stringify(r.new_data).length : 0
				const rowSize = oldSize + newSize + 256 // +256 fudge for fixed columns
				cumulative += rowSize
				if (cumulative > maxBatchBytes && i > 0) {
					cutoffIdx = i
					break
				}
			}

			if (cutoffIdx < records.length) {
				const releasedIds = records.slice(cutoffIdx).map((r) => r.id)
				await claimClient.query(
					`UPDATE ${this.auditTable}
            SET claim_id = NULL, claimed_at = NULL
            WHERE id = ANY($1::bigint[]) AND claim_id = $2`,
					[releasedIds, claimId],
				)
				this.logger.info(
					'Trimmed batch to stay under maxBatchBytes; tail released for next run',
					{
						claimId,
						kept: cutoffIdx,
						released: records.length - cutoffIdx,
						maxBatchBytes,
					},
				)
				records = records.slice(0, cutoffIdx)
			}

			await claimClient.query('COMMIT')
		} catch (err) {
			await claimClient.query('ROLLBACK').catch((rollbackErr) => {
				this.logger.warn('ROLLBACK failed in claim phase', {
					rollbackErr,
					originalError: err instanceof Error ? err.message : String(err),
				})
			})
			throw err
		} finally {
			claimClient.release()
		}

		// Phase 2: upload to S3 — no DB transaction or row lock held.
		let s3Path = ''
		let fileSize = 0
		let uploadedToS3 = false
		try {
			const uploaded = await this.uploadBatchToS3(records, tableName, date)
			s3Path = uploaded.s3Path
			const sha256 = uploaded.sha256
			uploadedToS3 = true

			const headResult = await this.s3Client.send(
				new HeadObjectCommand({
					Bucket: this.config.s3.bucket,
					Key: s3Path,
					ChecksumMode: 'ENABLED',
				}),
			)
			fileSize = headResult.ContentLength || 0

			if (!fileSize || fileSize === 0) {
				throw new Error(`S3 upload verification failed: ${s3Path}`)
			}

			const returnedChecksum = headResult.ChecksumSHA256
			if (returnedChecksum && returnedChecksum !== sha256) {
				throw new Error(
					`S3 upload checksum mismatch for ${s3Path}: expected ${sha256}, got ${returnedChecksum}`,
				)
			}
		} catch (err) {
			await this.releaseClaim(claimId).catch((releaseErr) => {
				this.logger.warn('Failed to release claim after upload failure', {
					claimId,
					err: releaseErr,
				})
			})
			if (uploadedToS3 && s3Path) {
				await this.s3Client
					.send(
						new DeleteObjectCommand({
							Bucket: this.config.s3.bucket,
							Key: s3Path,
						}),
					)
					.catch(() => {
						this.logger.warn(
							'Failed to clean up orphaned S3 file after upload failure',
							{ s3Path },
						)
					})
			}
			throw err
		}

		// Phase 3: finalize in a brief transaction. Match by claim_id so we never
		// touch rows belonging to a concurrent archiver. Detect the reaper-race
		// case where staleClaimMinutes elapsed during the upload and another
		// process reset our claim — in that case the UPDATE matches zero rows
		// and we must abort cleanly (delete the S3 file, skip metadata insert)
		// so the next run re-archives without orphan metadata.
		const finalizeClient = await this.pool.connect()
		let committed = false
		let raceLost = false
		try {
			await finalizeClient.query('BEGIN')

			const updateResult = await finalizeClient.query(
				`UPDATE ${this.auditTable}
         SET archived_at = NOW(),
             s3_path = $2,
             claim_id = NULL,
             claimed_at = NULL
         WHERE claim_id = $1
           AND archived_at IS NULL
         RETURNING id`,
				[claimId, s3Path],
			)

			const archivedCount = updateResult.rowCount || 0

			if (archivedCount === 0) {
				// Reaper stole the claim before we could finalize. ROLLBACK and let
				// the outer catch clean up S3 — do not write metadata for a batch
				// whose rows are about to be re-archived under a fresh claim.
				raceLost = true
				await finalizeClient.query('ROLLBACK')
				this.logger.warn(
					'Finalize matched zero rows — claim was reaped during upload. ' +
						'Increase staleClaimMinutes if this recurs.',
					{ claimId, s3Path, batchSize: records.length },
				)
			} else {
				const archiveDate = date.toISOString().split('T')[0]
				await finalizeClient.query(
					`INSERT INTO ${this.metadataTable} (
            table_name, archive_date, s3_path, record_count, file_size
          ) VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (s3_path) DO NOTHING`,
					[tableName, archiveDate, s3Path, archivedCount, fileSize],
				)

				await finalizeClient.query('COMMIT')
				committed = true
			}

			if (raceLost) {
				// Best-effort delete the orphaned S3 file; cleanupOrphanedFiles is
				// the backstop. Return recordCount=0 instead of throwing so the
				// orchestrator's batch loop exits cleanly and proceeds to soft/hard
				// delete phases for this table. The reaped rows will be re-archived
				// on the next archival cycle under a fresh claim.
				await this.s3Client
					.send(
						new DeleteObjectCommand({
							Bucket: this.config.s3.bucket,
							Key: s3Path,
						}),
					)
					.catch(() => {
						this.logger.warn('Failed to clean up S3 file after reaper race', {
							s3Path,
						})
					})
				return {
					recordCount: 0,
					fileSize: 0,
					s3Path: '',
					status: 'completed',
				}
			}

			return {
				recordCount: archivedCount,
				fileSize,
				s3Path,
				status: 'completed',
			}
		} catch (err) {
			if (!committed) {
				await finalizeClient.query('ROLLBACK').catch((rollbackErr) => {
					this.logger.warn('ROLLBACK failed in finalize phase', {
						rollbackErr,
						originalError: err instanceof Error ? err.message : String(err),
					})
				})
			}
			await this.releaseClaim(claimId).catch((releaseErr) => {
				this.logger.warn('releaseClaim failed after finalize error', {
					claimId,
					releaseErr,
				})
			})
			// Guard against deleting with empty Key — defensive for the case where
			// finalize throws before s3Path is captured (currently unreachable
			// because Phase 2 always sets s3Path on success, but cheap to keep).
			if (s3Path) {
				await this.s3Client
					.send(
						new DeleteObjectCommand({
							Bucket: this.config.s3.bucket,
							Key: s3Path,
						}),
					)
					.catch(() => {
						this.logger.warn(
							'Failed to clean up orphaned S3 file after finalize failure',
							{ s3Path },
						)
					})
			}
			throw err
		} finally {
			finalizeClient.release()
		}
	}

	/**
	 * Release a claim so its rows return to the pending pool. Idempotent and
	 * safe to call after a successful archival — the archived_at IS NULL guard
	 * prevents touching rows that were already finalized by a concurrent path.
	 */
	private async releaseClaim(claimId: string): Promise<void> {
		await this.pool.query(
			`UPDATE ${this.auditTable}
       SET claim_id = NULL,
           claimed_at = NULL
       WHERE claim_id = $1
         AND archived_at IS NULL`,
			[claimId],
		)
	}

	/**
	 * Reset claims older than staleClaimMinutes (default 30). A worker that
	 * crashed between claim and finalize leaves rows tagged with a claim_id
	 * indefinitely; this method releases them so the next archival run can
	 * reclaim them. Run on a schedule (e.g. every minute) or at the start of
	 * each archival run.
	 *
	 * Returns the number of stale claims released.
	 */
	async reapStaleClaims(staleAfterMinutes?: number): Promise<number> {
		await this.ensureSchemaReady()
		await this.ensurePool()
		// Default 30 minutes: NodeHttpHandler caps S3 requests at 30s and
		// retries at most a few times, so a healthy upload completes well under
		// 2 minutes. 30 min gives ~15x headroom before the reaper races finalize.
		const minutes = staleAfterMinutes ?? this.config.staleClaimMinutes ?? 30
		if (!Number.isFinite(minutes) || minutes < 1) {
			throw new Error(
				`reapStaleClaims: staleAfterMinutes must be a positive finite number (got: ${minutes})`,
			)
		}
		const result = await this.pool.query(
			`UPDATE ${this.auditTable}
       SET claim_id = NULL,
           claimed_at = NULL
       WHERE claim_id IS NOT NULL
         AND archived_at IS NULL
         AND claimed_at < NOW() - ($1 * INTERVAL '1 minute')`,
			[minutes],
		)
		return result.rowCount || 0
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
	async cleanupOrphanedFiles(
		tableName: string,
		opts: { maxDeletions?: number } = {},
	): Promise<number> {
		await this.ensureSchemaReady()
		validateIdentifier(tableName, 'table')
		await this.ensurePool()

		// Default cap: 10k orphans per call. Buckets with millions of objects
		// would otherwise loop for hours, hold a DB client, and time out any
		// HTTP layer above. Caller can pass a different cap and resume on the
		// next invocation — orphan detection is idempotent.
		const maxDeletions = opts.maxDeletions ?? 10_000
		let continuationToken: string | undefined
		let orphanCount = 0

		outer: do {
			const listCommand = new ListObjectsV2Command({
				Bucket: this.config.s3.bucket,
				Prefix: `${tableName}/`,
				ContinuationToken: continuationToken,
			})
			const listResult = await this.s3Client.send(listCommand)

			const pageKeys = (listResult.Contents || [])
				.map((obj) => obj.Key)
				.filter((key): key is string => !!key && key.endsWith('.parquet'))

			if (pageKeys.length > 0) {
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
					if (orphanCount >= maxDeletions) {
						this.logger.info(
							'cleanupOrphanedFiles hit maxDeletions; resume on next call',
							{ tableName, deleted: orphanCount, maxDeletions },
						)
						break outer
					}
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
	 * Delete archive metadata + S3 files older than the cutoff. Paired deletion
	 * keeps metadata and S3 in sync — `cleanupOrphanedFiles` treats any S3 file
	 * not present in metadata as an orphan, so deleting metadata first would
	 * cause the next cleanup pass to remove the corresponding file anyway, but
	 * doing both atomically here is faster and surfaces partial failures.
	 *
	 * Use when long-term archival storage costs outweigh compliance retention
	 * requirements. Returns the number of S3 files successfully deleted.
	 */
	async pruneArchive(tableName: string, olderThan: Date): Promise<number> {
		await this.ensureSchemaReady()
		validateIdentifier(tableName, 'table')
		await this.ensurePool()

		const candidates = await this.pool.query(
			`SELECT s3_path FROM ${this.metadataTable}
       WHERE table_name = $1 AND archived_at < $2
       ORDER BY archived_at ASC
       LIMIT 10000`,
			[tableName, olderThan],
		)

		let deleted = 0
		for (const row of candidates.rows as Array<{ s3_path: string }>) {
			try {
				await this.s3Client.send(
					new DeleteObjectCommand({
						Bucket: this.config.s3.bucket,
						Key: row.s3_path,
					}),
				)
				await this.pool.query(
					`DELETE FROM ${this.metadataTable} WHERE s3_path = $1`,
					[row.s3_path],
				)
				deleted++
			} catch (err) {
				this.logger.warn('Failed to prune archive entry', {
					s3Path: row.s3_path,
					err: err instanceof Error ? err.message : String(err),
				})
			}
		}
		return deleted
	}

	/**
	 * Soft delete archived records past grace period in batches.
	 * ONLY if s3_path is set (proof of backup).
	 * Uses a subquery with LIMIT to avoid locking millions of rows at once.
	 * Orders by id ASC for deterministic oldest-first batch progression.
	 */
	async softDeleteArchived(tableName: string): Promise<number> {
		await this.ensureSchemaReady()
		await this.ensurePool()
		const batchSize = this.config.batchSize || 10000

		// Wrap in a brief transaction so SET LOCAL statement_timeout bounds the
		// UPDATE without leaking onto the pooled connection.
		const client = await this.pool.connect()
		try {
			await client.query('BEGIN')
			await client.query('SET LOCAL statement_timeout = 60000')
			const result = await client.query(
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
			await client.query('COMMIT')
			return result.rowCount || 0
		} catch (err) {
			await client.query('ROLLBACK').catch((rollbackErr) => {
				this.logger.warn('ROLLBACK failed in softDeleteArchived', {
					rollbackErr,
					originalError: err instanceof Error ? err.message : String(err),
				})
			})
			throw err
		} finally {
			client.release()
		}
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
		await this.ensureSchemaReady()
		await this.ensurePool()

		// Step 1: Get candidate records with their S3 paths.
		// Only select records that have an s3_path (proof of backup).
		// Records without s3_path should not have been soft-deleted,
		// but if they were, we skip them to avoid data loss.
		// Order by id ASC so hard-delete progress is deterministic (oldest first).
		// Use database NOW() for clock-skew safety (consistent with processBatch).
		// Bound the pre-transaction scan with statement_timeout so an unindexed
		// or bloated partition can't tie up the connection forever.
		const batchSize = this.config.batchSize || 10000
		const scanClient = await this.pool.connect()
		let checkResult: { rows: Array<{ id: string; s3_path: string }> }
		try {
			await scanClient.query('BEGIN')
			await scanClient.query('SET LOCAL statement_timeout = 60000')
			checkResult = await scanClient.query(
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
			await scanClient.query('COMMIT')
		} catch (err) {
			await scanClient.query('ROLLBACK').catch(() => {})
			throw err
		} finally {
			scanClient.release()
		}

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

			// Re-verify S3 files exist *inside* the transaction, after acquiring
			// row locks. The DB lock protects against concurrent UPDATE to s3_path,
			// but cannot protect against external deletion of the S3 object between
			// the pre-lock verifyS3File and the DELETE. Cap the in-TX verification
			// set to bound lock duration: each HeadObject is ~50ms; verifying 10k
			// paths × 50ms × (1/CONCURRENCY=10) = ~50s of lock-holding which would
			// starve the connection pool on long-running archive backlogs.
			const MAX_INLINE_VERIFY = 500
			let pathsToReverify = verifiedPathsArray
			if (pathsToReverify.length > MAX_INLINE_VERIFY) {
				this.logger.info(
					'hardDeletePurged trimming in-TX verification to bound lock duration',
					{
						total: pathsToReverify.length,
						verifying: MAX_INLINE_VERIFY,
					},
				)
				pathsToReverify = pathsToReverify.slice(0, MAX_INLINE_VERIFY)
			}
			const reverifiedPaths = new Set<string>()
			for (let i = 0; i < pathsToReverify.length; i += CONCURRENCY) {
				const batch = pathsToReverify.slice(i, i + CONCURRENCY)
				const results = await Promise.all(
					batch.map(async (s3Path) => ({
						s3Path,
						exists: await this.verifyS3File(s3Path),
					})),
				)
				for (const { s3Path, exists } of results) {
					if (exists) reverifiedPaths.add(s3Path)
					else
						this.logger.warn(
							'S3 file disappeared between verify and delete, skipping',
							{ s3Path },
						)
				}
			}

			if (reverifiedPaths.size === 0) {
				await client.query('ROLLBACK')
				return 0
			}

			// Final DELETE filters by the freshly-reverified path set so a row
			// whose S3 file was deleted externally during the lock-acquisition
			// window is left alone (will be retried on next run).
			const reverifiedPathsArr = Array.from(reverifiedPaths)
			const deleteResult = await client.query(
				`DELETE FROM ${this.auditTable}
        WHERE id = ANY($1::bigint[])
          AND s3_path = ANY($2::text[])`,
				[lockedIds, reverifiedPathsArr],
			)

			await client.query('COMMIT')
			return deleteResult.rowCount || 0
		} catch (err) {
			await client.query('ROLLBACK').catch((rollbackErr) => {
				this.logger.warn('ROLLBACK failed in hardDeletePurged', {
					rollbackErr,
					originalError: err instanceof Error ? err.message : String(err),
				})
			})
			throw err
		} finally {
			client.release()
		}
	}

	async close(timeoutMs: number = 30_000): Promise<void> {
		if (!this.ownConnection || !this.pool) return
		await endPoolWithTimeout(this.pool, timeoutMs, this.logger, 'Archiver')
	}
}

interface BatchResult {
	recordCount: number
	fileSize: number
	s3Path: string
	status: 'completed' | 'failed'
	errorMessage?: string
}
