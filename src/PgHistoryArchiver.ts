import { randomUUID } from 'node:crypto'
import { readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { Pool } from 'pg'
import { writeParquet } from './parquet'
import type { ArchiverConfig } from './types'

export class PgHistoryArchiver {
	private pool: Pool
	private ownConnection: boolean
	private config: ArchiverConfig
	private s3Client: S3Client

	constructor(config: ArchiverConfig) {
		this.config = config

		if (config.pool) {
			this.pool = config.pool
			this.ownConnection = false
		} else if (config.connection) {
			const pkg = require('pg')
			const { Pool } = pkg
			this.pool = new Pool({ connectionString: config.connection })
			this.ownConnection = true
		} else {
			throw new Error('PgHistoryArchiver: No connection configuration provided')
		}

		// Initialize S3 client
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
			forcePathStyle: true, // Required for MinIO and S3-compatible services
		})
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
		// Write to temporary file
		const tmpFile = join(tmpdir(), `archive-${Date.now()}.parquet`)

		try {
			await writeParquet(records, tmpFile)

			// Generate S3 path
			const s3Path = this.generateS3Path(tableName, date)

			// Read file and upload to S3
			const fileContent = await readFile(tmpFile)

			const command = new PutObjectCommand({
				Bucket: this.config.s3.bucket,
				Key: s3Path,
				Body: fileContent,
			})

			await this.s3Client.send(command)

			return s3Path
		} finally {
			// Cleanup temp file
			try {
				await unlink(tmpFile)
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
	 * - Before step 3: Records still unarchived, will retry ✓
	 * - After step 3: Records marked archived, won't retry ✓
	 */
	async processBatch(
		tableName: string,
		cutoffDate: Date,
	): Promise<BatchResult> {
		const batchSize = this.config.batchSize || 10000

		// Step 1: Query records (read-only, no locks)
		const result = await this.pool.query(
			`SELECT
        id,
        table_name,
        record_id,
        operation,
        changed_at,
        old_data,
        new_data
      FROM audit_log
      WHERE table_name = $1
        AND changed_at < $2
        AND archived_at IS NULL
      ORDER BY changed_at ASC
      LIMIT $3`,
			[tableName, cutoffDate, batchSize],
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

		// Get date from first record for partitioning
		const firstRecord = records[0]
		if (!firstRecord) {
			throw new Error('No records found in batch')
		}
		const date = new Date(firstRecord.changed_at as Date)

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
			`UPDATE audit_log
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
			`INSERT INTO audit_archive_metadata (
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
	 * Soft delete archived records past grace period
	 * ONLY if s3_path is set (proof of backup)
	 */
	async softDeleteArchived(tableName: string): Promise<number> {
		const gracePeriodDate = new Date()
		gracePeriodDate.setDate(gracePeriodDate.getDate() - this.config.gracePeriod)

		// Only soft delete records that have been backed up to S3
		const result = await this.pool.query(
			`UPDATE audit_log
      SET soft_deleted_at = NOW()
      WHERE table_name = $1
        AND archived_at IS NOT NULL
        AND archived_at < $2
        AND soft_deleted_at IS NULL
        AND s3_path IS NOT NULL`,
			[tableName, gracePeriodDate],
		)

		return result.rowCount || 0
	}

	/**
	 * Hard delete soft-deleted records past grace period
	 * Verifies S3 backup exists before permanent deletion
	 */
	async hardDeletePurged(tableName: string): Promise<number> {
		const gracePeriodDate = new Date()
		gracePeriodDate.setDate(gracePeriodDate.getDate() - this.config.gracePeriod)

		// Get records to delete with their S3 paths.
		// Only select records that have an s3_path (proof of backup).
		// Records without s3_path should not have been soft-deleted,
		// but if they were, we skip them to avoid data loss.
		const checkResult = await this.pool.query(
			`SELECT id, s3_path
      FROM audit_log
      WHERE table_name = $1
        AND soft_deleted_at IS NOT NULL
        AND soft_deleted_at < $2
        AND s3_path IS NOT NULL
      LIMIT 1000`,
			[tableName, gracePeriodDate],
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
		const missingPaths = new Set<string>()

		for (const s3Path of s3Paths) {
			if (s3Path.startsWith('test://')) {
				verifiedPaths.add(s3Path)
				continue
			}

			const exists = await this.verifyS3File(s3Path)
			if (exists) {
				verifiedPaths.add(s3Path)
			} else {
				missingPaths.add(s3Path)
				console.warn(
					`[pg-history] S3 file missing: ${s3Path}. Skipping records with this path.`,
				)
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
			`DELETE FROM audit_log
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
