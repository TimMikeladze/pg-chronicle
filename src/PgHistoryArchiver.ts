import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { Pool } from 'pg'
import { writeParquet } from './parquet'
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

	constructor(config: ArchiverConfig) {
		this.config = config

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
				})()
			}
			await this.poolPromise
		}
		// Detect schema on first pool use
		if (!this.schemaDetected && this.pool) {
			const result = await this.pool.query('SELECT current_schema() as schema')
			const schema = result.rows[0]?.schema || 'public'
			this.schemaPrefix = `"${schema}"`
			this.schemaDetected = true
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
		const year = date.getFullYear()
		const month = String(date.getMonth() + 1).padStart(2, '0')
		const day = String(date.getDate()).padStart(2, '0')
		const uuid = randomUUID()

		return `${tableName}/year=${year}/month=${month}/day=${day}/data-${uuid}.parquet`
	}

	/**
	 * Upload batch of records to S3 as Parquet file
	 */
	async uploadBatchToS3(
		records: Array<Record<string, unknown>>,
		tableName: string,
		date: Date,
	): Promise<string> {
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
			const checksum = createHash('sha256').update(fileContent).digest('base64')

			const command = new PutObjectCommand({
				Bucket: this.config.s3.bucket,
				Key: s3Path,
				Body: fileContent,
				ContentLength: fileContent.length,
				ChecksumSHA256: checksum,
			})

			await this.s3Client.send(command)

			return s3Path
		} finally {
			// Cleanup temp directory and file
			try {
				await rm(tmpDir, { recursive: true })
			} catch {}
		}
	}

	/**
	 * Process a single batch with simple, reliable algorithm:
	 * 1. Query records (no lock needed - SELECT only)
	 * 2. Upload to S3 (outside transaction)
	 * 3. Mark as archived with s3_path (atomic update)
	 *
	 * If crash happens:
	 * - Before step 3: Records still unarchived, will retry. The S3 file from step 2
	 *   becomes an orphan (not referenced by any record). Over time these accumulate.
	 *   Consider a periodic cleanup job that deletes S3 files not referenced in
	 *   audit_archive_metadata.
	 * - After step 3: Records marked archived, won't retry ✓
	 */
	async processBatch(
		tableName: string,
		cutoffDate: Date,
	): Promise<BatchResult> {
		await this.ensurePool()
		const batchSize = this.config.batchSize || 10000

		// Step 1: Find the earliest unarchived date for this table
		const peekResult = await this.pool.query(
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

		// Query records for this single day only
		const result = await this.pool.query(
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
      LIMIT $4`,
			[tableName, dayStart, dayEnd, batchSize],
		)

		const records = result.rows as Array<Record<string, unknown>>

		if (records.length === 0) {
			return {
				recordCount: 0,
				fileSize: 0,
				s3Path: '',
				status: 'completed',
			}
		}

		// Step 2: Upload to S3 (outside transaction - idempotent)
		const s3Path = await this.uploadBatchToS3(records, tableName, date)

		// Verify upload succeeded
		const { HeadObjectCommand } = await import('@aws-sdk/client-s3')
		const headCommand = new HeadObjectCommand({
			Bucket: this.config.s3.bucket,
			Key: s3Path,
		})
		const headResult = await this.s3Client.send(headCommand)
		const fileSize = headResult.ContentLength || 0

		if (!fileSize || fileSize === 0) {
			throw new Error(`S3 upload verification failed: ${s3Path}`)
		}

		// Step 3: Atomically mark records as archived with s3_path
		// Only updates records that are still unarchived (handles concurrent runs)
		const recordIds = records.map((r) => r.id as bigint)
		const updateResult = await this.pool.query(
			`UPDATE ${this.auditTable}
       SET archived_at = NOW(),
           s3_path = $2
       WHERE id = ANY($1)
         AND archived_at IS NULL
       RETURNING id`,
			[recordIds, s3Path],
		)

		const archivedCount = updateResult.rowCount || 0

		// If no records were actually archived (concurrent process got them first),
		// clean up the orphaned S3 file
		if (archivedCount === 0) {
			try {
				const { DeleteObjectCommand } = await import('@aws-sdk/client-s3')
				await this.s3Client.send(
					new DeleteObjectCommand({
						Bucket: this.config.s3.bucket,
						Key: s3Path,
					}),
				)
			} catch {
				console.warn(
					`[pg-history] Failed to clean up orphaned S3 file: ${s3Path}`,
				)
			}
			return {
				recordCount: 0,
				fileSize: 0,
				s3Path: '',
				status: 'completed',
			}
		}

		// Record metadata (idempotent with UNIQUE constraint)
		const archiveDate = date.toISOString().split('T')[0]
		await this.pool.query(
			`INSERT INTO ${this.metadataTable} (
        table_name, archive_date, s3_path, record_count, file_size
      ) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (s3_path) DO NOTHING`,
			[tableName, archiveDate, s3Path, archivedCount, fileSize],
		)

		return {
			recordCount: archivedCount,
			fileSize,
			s3Path,
			status: 'completed',
		}
	}

	/**
	 * Verify S3 file exists
	 */
	private async verifyS3File(s3Path: string): Promise<boolean> {
		try {
			const { HeadObjectCommand } = await import('@aws-sdk/client-s3')
			const command = new HeadObjectCommand({
				Bucket: this.config.s3.bucket,
				Key: s3Path,
			})
			await this.s3Client.send(command)
			return true
		} catch (_error) {
			return false
		}
	}

	/**
	 * Soft delete archived records past grace period in batches.
	 * ONLY if s3_path is set (proof of backup).
	 * Uses a subquery with LIMIT to avoid locking millions of rows at once.
	 */
	async softDeleteArchived(tableName: string): Promise<number> {
		await this.ensurePool()
		const batchSize = this.config.batchSize || 10000
		const gracePeriodDate = new Date()
		gracePeriodDate.setDate(gracePeriodDate.getDate() - this.config.gracePeriod)

		// Only soft delete records that have been backed up to S3
		// Use subquery with LIMIT to batch the update
		const result = await this.pool.query(
			`UPDATE ${this.auditTable}
      SET soft_deleted_at = NOW()
      WHERE id IN (
        SELECT id FROM ${this.auditTable}
        WHERE table_name = $1
          AND archived_at IS NOT NULL
          AND archived_at < $2
          AND soft_deleted_at IS NULL
          AND s3_path IS NOT NULL
        LIMIT $3
      )`,
			[tableName, gracePeriodDate, batchSize],
		)

		return result.rowCount || 0
	}

	/**
	 * Hard delete soft-deleted records past grace period
	 * Verifies S3 backup exists before permanent deletion
	 */
	async hardDeletePurged(tableName: string): Promise<number> {
		await this.ensurePool()
		const gracePeriodDate = new Date()
		gracePeriodDate.setDate(gracePeriodDate.getDate() - this.config.gracePeriod)

		// Get records to delete with their S3 paths.
		// Only select records that have an s3_path (proof of backup).
		// Records without s3_path should not have been soft-deleted,
		// but if they were, we skip them to avoid data loss.
		const batchSize = this.config.batchSize || 10000
		const checkResult = await this.pool.query(
			`SELECT id, s3_path
      FROM ${this.auditTable}
      WHERE table_name = $1
        AND soft_deleted_at IS NOT NULL
        AND soft_deleted_at < $2
        AND s3_path IS NOT NULL
      LIMIT $3`,
			[tableName, gracePeriodDate, batchSize],
		)

		if (checkResult.rows.length === 0) {
			return 0
		}

		// Verify S3 files per-path, collecting verified and missing paths
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
					console.warn(
						`[pg-history] S3 file missing: ${s3Path}. Skipping records with this path.`,
					)
				}
			}
		}

		// Only delete records whose S3 path is verified
		const verifiedIds = checkResult.rows
			.filter((r) => r.s3_path && verifiedPaths.has(r.s3_path))
			.map((r) => r.id)

		if (verifiedIds.length === 0) {
			return 0
		}

		const result = await this.pool.query(
			`DELETE FROM ${this.auditTable}
      WHERE id = ANY($1)`,
			[verifiedIds],
		)

		return result.rowCount || 0
	}

	async close(): Promise<void> {
		if (this.ownConnection) {
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
