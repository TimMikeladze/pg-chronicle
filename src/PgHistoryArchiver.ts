import { unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SQL, s3 } from 'bun'
import { writeParquet } from './parquet'
import type { ArchiverConfig } from './types'

export class PgHistoryArchiver {
	private sql: SQL
	private ownConnection: boolean
	private config: ArchiverConfig

	constructor(config: ArchiverConfig) {
		this.config = config

		if (config.sql) {
			this.sql = config.sql
			this.ownConnection = false
		} else if (config.connection) {
			this.sql = new SQL(config.connection)
			this.ownConnection = true
		} else {
			throw new Error('PgHistoryArchiver: No connection configuration provided')
		}
	}

	/**
	 * Query old records for a table that need archival
	 */
	async queryOldRecords(
		tableName: string,
		cutoffDate: Date,
		limit: number,
	): Promise<Array<Record<string, unknown>>> {
		const records = await this.sql`
      SELECT
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
      WHERE table_name = ${tableName}
        AND changed_at < ${cutoffDate}
        AND archived_at IS NULL
      ORDER BY changed_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `

		return records as Array<Record<string, unknown>>
	}

	/**
	 * Generate S3 path with Hive partitioning
	 */
	generateS3Path(tableName: string, date: Date, partNumber: number): string {
		const year = date.getFullYear()
		const month = String(date.getMonth() + 1).padStart(2, '0')
		const day = String(date.getDate()).padStart(2, '0')
		const part = String(partNumber).padStart(5, '0')

		return `${tableName}/year=${year}/month=${month}/day=${day}/part-${part}.parquet`
	}

	/**
	 * Upload batch of records to S3 as Parquet file
	 */
	async uploadBatchToS3(
		records: Array<Record<string, unknown>>,
		tableName: string,
		date: Date,
		partNumber: number,
	): Promise<string> {
		// Write to temporary file
		const tmpFile = join(tmpdir(), `archive-${Date.now()}.parquet`)

		try {
			await writeParquet(records, tmpFile)

			// Generate S3 path
			const s3Path = this.generateS3Path(tableName, date, partNumber)

			// Upload to S3
			const s3File = s3.file(s3Path, {
				bucket: this.config.s3.bucket,
				accessKeyId: this.config.s3.accessKeyId,
				secretAccessKey: this.config.s3.secretAccessKey,
				endpoint: this.config.s3.endpoint,
				region: this.config.s3.region,
			})

			await s3File.write(Bun.file(tmpFile))

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
		partNumber: number,
	): Promise<BatchResult> {
		const batchSize = this.config.batchSize || 10000

		// Use sql.begin() for transaction support
		return await this.sql.begin(async (tx) => {
			// Query records with lock
			const records = (await tx`
        SELECT
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
        WHERE table_name = ${tableName}
          AND changed_at < ${cutoffDate}
          AND archived_at IS NULL
        ORDER BY changed_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `) as Array<Record<string, unknown>>

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

			// Upload to S3
			const s3Path = await this.uploadBatchToS3(
				records,
				tableName,
				date,
				partNumber,
			)

			// Mark records as archived
			const recordIds = records.map((r) => r.id as string)
			// Use proper PostgreSQL array syntax
			const arrayLiteral = `{${recordIds.join(',')}}`
			await tx`
        UPDATE audit_log
        SET archived_at = NOW()
        WHERE id = ANY(${arrayLiteral}::text[])
      `

			// Get file size for metadata
			const s3File = s3.file(s3Path, {
				bucket: this.config.s3.bucket,
				endpoint: this.config.s3.endpoint,
				accessKeyId: this.config.s3.accessKeyId,
				secretAccessKey: this.config.s3.secretAccessKey,
				region: this.config.s3.region,
			})
			const fileSizeValue = await s3File.size
			// Ensure fileSize is a valid integer within PostgreSQL BIGINT range
			const fileSize =
				typeof fileSizeValue === 'number' && Number.isFinite(fileSizeValue)
					? Math.floor(fileSizeValue)
					: 0

			// Record metadata
			// Format date as YYYY-MM-DD for PostgreSQL DATE type
			const archiveDate = date.toISOString().split('T')[0]
			await tx`
        INSERT INTO audit_archive_metadata (
          table_name, archive_date, s3_path, record_count, file_size, status
        ) VALUES (
          ${tableName},
          ${archiveDate},
          ${s3Path},
          ${records.length},
          ${fileSize},
          'completed'
        )
      `

			// Transaction will auto-commit on success, rollback on throw
			return {
				recordCount: records.length,
				fileSize,
				s3Path,
				status: 'completed',
			}
		})
	}

	/**
	 * Soft delete archived records past grace period
	 */
	async softDeleteArchived(tableName: string): Promise<number> {
		const gracePeriodDate = new Date()
		gracePeriodDate.setDate(gracePeriodDate.getDate() - this.config.gracePeriod)

		const result = await this.sql`
      UPDATE audit_log
      SET soft_deleted_at = NOW()
      WHERE table_name = ${tableName}
        AND archived_at IS NOT NULL
        AND archived_at < ${gracePeriodDate}
        AND soft_deleted_at IS NULL
    `

		return result.count || 0
	}

	/**
	 * Hard delete soft-deleted records past grace period
	 */
	async hardDeletePurged(tableName: string): Promise<number> {
		const gracePeriodDate = new Date()
		gracePeriodDate.setDate(gracePeriodDate.getDate() - this.config.gracePeriod)

		const result = await this.sql`
      DELETE FROM audit_log
      WHERE table_name = ${tableName}
        AND soft_deleted_at IS NOT NULL
        AND soft_deleted_at < ${gracePeriodDate}
    `

		return result.count || 0
	}

	async close(): Promise<void> {
		if (this.ownConnection) {
			// Bun.SQL doesn't have explicit close, connection pool managed automatically
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
