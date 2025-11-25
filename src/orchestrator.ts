import type { Pool } from 'pg'
import { updateArchivalStats } from './schema'
import type {
	ConfigFile,
	OrchestratorStats,
	RunOptions,
	TableStats,
} from './types'

export class Orchestrator {
	constructor(private config: ConfigFile) {}

	async discoverTables(pool: Pool): Promise<string[]> {
		// Query pg_trigger to find tables with audit triggers
		// This is much faster than scanning audit_log table
		const result = await pool.query(`
      SELECT DISTINCT
        t.tgrelid::regclass::text AS table_name
      FROM pg_trigger t
      WHERE t.tgname LIKE 'audit_trigger_%'
      ORDER BY table_name
    `)

		return result.rows.map((row: { table_name: string }) => row.table_name)
	}

	getRetentionCutoff(tableName: string): Date {
		const retentionDays =
			this.config.retention.tables?.[tableName] || this.config.retention.default
		const cutoff = new Date()
		cutoff.setDate(cutoff.getDate() - retentionDays)
		return cutoff
	}

	async run(pool: Pool, options: RunOptions = {}): Promise<OrchestratorStats> {
		const startTime = Date.now()
		const stats: OrchestratorStats = {
			tables: [],
			totalRecordsArchived: 0,
			totalRecordsSoftDeleted: 0,
			totalRecordsHardDeleted: 0,
			errors: [],
			durationMs: 0,
		}

		// Discover tables (or use single target)
		const tables = options.targetTable
			? [options.targetTable]
			: await this.discoverTables(pool)

		stats.tables = tables

		// Process each table
		for (const table of tables) {
			try {
				const tableStats = await this.processTable(pool, table, options)
				stats.totalRecordsArchived += tableStats.recordsArchived
				stats.totalRecordsSoftDeleted += tableStats.recordsSoftDeleted
				stats.totalRecordsHardDeleted += tableStats.recordsHardDeleted
			} catch (error) {
				stats.errors.push({
					table,
					operation: 'process_table',
					error: error instanceof Error ? error.message : String(error),
				})
			}
		}

		stats.durationMs = Date.now() - startTime
		return stats
	}

	private async processTable(
		pool: Pool,
		tableName: string,
		options: RunOptions,
	): Promise<TableStats> {
		const startTime = Date.now()
		const stats: TableStats = {
			tableName,
			recordsArchived: 0,
			recordsSoftDeleted: 0,
			recordsHardDeleted: 0,
			durationMs: 0,
		}

		const cutoff = this.getRetentionCutoff(tableName)
		const gracePeriodDate = new Date()
		gracePeriodDate.setDate(gracePeriodDate.getDate() - this.config.gracePeriod)

		if (options.dryRun) {
			// Dry run: count what would be processed
			const archiveCount = await pool.query(
				`SELECT COUNT(*) as count
        FROM audit_log
        WHERE table_name = $1
          AND changed_at < $2
          AND archived_at IS NULL`,
				[tableName, cutoff],
			)

			const softDeleteCount = await pool.query(
				`SELECT COUNT(*) as count
        FROM audit_log
        WHERE table_name = $1
          AND archived_at IS NOT NULL
          AND archived_at < $2
          AND soft_deleted_at IS NULL
          AND s3_path IS NOT NULL`,
				[tableName, gracePeriodDate],
			)

			const hardDeleteCount = await pool.query(
				`SELECT COUNT(*) as count
        FROM audit_log
        WHERE table_name = $1
          AND soft_deleted_at IS NOT NULL
          AND soft_deleted_at < $2`,
				[tableName, gracePeriodDate],
			)

			console.log(`[DRY RUN] ${tableName}:`)
			console.log(
				`  Would archive: ${archiveCount.rows[0]?.count || 0} records`,
			)
			console.log(
				`  Would soft delete: ${softDeleteCount.rows[0]?.count || 0} records`,
			)
			console.log(
				`  Would hard delete: ${hardDeleteCount.rows[0]?.count || 0} records`,
			)

			stats.durationMs = Date.now() - startTime
			return stats
		}

		// Create archiver
		const { PgHistoryArchiver } = await import('./PgHistoryArchiver')
		const archiver = new PgHistoryArchiver({
			pool,
			s3: this.config.s3,
			retention: this.config.retention,
			gracePeriod: this.config.gracePeriod,
			batchSize: this.config.batchSize,
		})

		// Archive old records in batches with retry
		let hasMore = true
		let batchNumber = 0

		while (hasMore) {
			batchNumber++

			try {
				// Use processBatch with S3 upload
				const batchResult = await archiver.processBatch(tableName, cutoff)

				stats.recordsArchived += batchResult.recordCount

				if (batchResult.recordCount === 0) {
					hasMore = false
				} else {
					console.log(
						`  Batch ${batchNumber}: Archived ${batchResult.recordCount} records to ${batchResult.s3Path}`,
					)
				}
			} catch (error) {
				// Log error but continue with next batch
				console.error(
					`  Batch ${batchNumber} failed: ${error instanceof Error ? error.message : String(error)}`,
				)
				// Stop processing this table on error
				throw error
			}
		}

		// Soft delete archived records past grace period
		console.log(`  Soft deleting records past grace period...`)
		const softDeleted = await archiver.softDeleteArchived(tableName)
		stats.recordsSoftDeleted = softDeleted
		if (softDeleted > 0) {
			console.log(`  Soft deleted ${softDeleted} records`)
		}

		// Hard delete soft-deleted records past grace period
		console.log(`  Hard deleting soft-deleted records...`)
		let totalHardDeleted = 0
		let hardDeleteHasMore = true

		// Process hard deletes in batches (they verify S3 each time)
		while (hardDeleteHasMore) {
			const hardDeleted = await archiver.hardDeletePurged(tableName)
			totalHardDeleted += hardDeleted

			if (hardDeleted === 0) {
				hardDeleteHasMore = false
			} else {
				console.log(`  Hard deleted ${hardDeleted} records`)
			}
		}

		stats.recordsHardDeleted = totalHardDeleted

		// Update stats table for fast querying (avoid future audit_log scans)
		const retentionDays =
			this.config.retention.tables?.[tableName] || this.config.retention.default
		await updateArchivalStats(
			pool,
			tableName,
			retentionDays,
			this.config.gracePeriod,
		)

		stats.durationMs = Date.now() - startTime
		return stats
	}
}
