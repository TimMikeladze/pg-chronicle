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
	 * Query old records for a table that need archival
	 */
	async queryOldRecords(
		tableName: string,
		cutoffDate: Date,
		limit: number,
	): Promise<Array<Record<string, unknown>>> {
		const result = await this.pool.query(
			`SELECT
        id,
        table_name,
        record_id,
        operation,
        changed_at,
        old_data,
        new_data,
        changed_by,
        metadata
      FROM audit_log
      WHERE table_name = $1
        AND changed_at < $2
        AND archived_at IS NULL
      ORDER BY changed_at ASC
      LIMIT $3
      FOR UPDATE SKIP LOCKED`,
			[tableName, cutoffDate, limit],
		)

		return result.rows as Array<Record<string, unknown>>
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
	 * Process a single batch with transactional guarantees
	 */
	async processBatch(
		tableName: string,
		cutoffDate: Date,
	): Promise<BatchResult> {
		const batchSize = this.config.batchSize || 10000
		const client = await this.pool.connect()

		try {
			await client.query('BEGIN')

			// Query records with lock
			const result = await client.query(
				`SELECT
          id,
          table_name,
          record_id,
          operation,
          changed_at,
          old_data,
          new_data,
          changed_by,
          metadata
        FROM audit_log
        WHERE table_name = $1
          AND changed_at < $2
          AND archived_at IS NULL
        ORDER BY changed_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED`,
				[tableName, cutoffDate, batchSize],
			)

			const records = result.rows as Array<Record<string, unknown>>

			if (records.length === 0) {
				await client.query('COMMIT')
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

			// Upload to S3
			const s3Path = await this.uploadBatchToS3(records, tableName, date)

			// Mark records as archived
			const recordIds = records.map((r) => r.id as string)
			await client.query(
				'UPDATE audit_log SET archived_at = NOW() WHERE id = ANY($1::text[])',
				[recordIds],
			)

			// Get file size - use HeadObjectCommand to get metadata
			const { HeadObjectCommand } = await import('@aws-sdk/client-s3')
			const headCommand = new HeadObjectCommand({
				Bucket: this.config.s3.bucket,
				Key: s3Path,
			})
			const headResult = await this.s3Client.send(headCommand)
			const fileSize = headResult.ContentLength || 0

			// Record metadata
			// Format date as YYYY-MM-DD for PostgreSQL DATE type
			const archiveDate = date.toISOString().split('T')[0]
			await client.query(
				`INSERT INTO audit_archive_metadata (
          table_name, archive_date, s3_path, record_count, file_size, status
        ) VALUES ($1, $2, $3, $4, $5, $6)`,
				[tableName, archiveDate, s3Path, records.length, fileSize, 'completed'],
			)

			await client.query('COMMIT')

			return {
				recordCount: records.length,
				fileSize,
				s3Path,
				status: 'completed',
			}
		} catch (error) {
			await client.query('ROLLBACK')
			throw error
		} finally {
			client.release()
		}
	}

	/**
	 * Soft delete archived records past grace period
	 */
	async softDeleteArchived(tableName: string): Promise<number> {
		const gracePeriodDate = new Date()
		gracePeriodDate.setDate(gracePeriodDate.getDate() - this.config.gracePeriod)

		const result = await this.pool.query(
			`UPDATE audit_log
      SET soft_deleted_at = NOW()
      WHERE table_name = $1
        AND archived_at IS NOT NULL
        AND archived_at < $2
        AND soft_deleted_at IS NULL`,
			[tableName, gracePeriodDate],
		)

		return result.rowCount || 0
	}

	/**
	 * Hard delete soft-deleted records past grace period
	 */
	async hardDeletePurged(tableName: string): Promise<number> {
		const gracePeriodDate = new Date()
		gracePeriodDate.setDate(gracePeriodDate.getDate() - this.config.gracePeriod)

		const result = await this.pool.query(
			`DELETE FROM audit_log
      WHERE table_name = $1
        AND soft_deleted_at IS NOT NULL
        AND soft_deleted_at < $2`,
			[tableName, gracePeriodDate],
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
