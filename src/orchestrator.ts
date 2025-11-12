import type { SQL } from 'bun'
import type {
	ConfigFile,
	OrchestratorStats,
	RunOptions,
	TableStats,
} from './types'

export class Orchestrator {
	constructor(private config: ConfigFile) {}

	async discoverTables(sql: SQL): Promise<string[]> {
		const result = await sql`
      SELECT DISTINCT table_name
      FROM audit_log
      ORDER BY table_name
    `

		return result.map((row: { table_name: string }) => row.table_name)
	}

	getRetentionCutoff(tableName: string): Date {
		const retentionDays =
			this.config.retention.tables?.[tableName] || this.config.retention.default
		const cutoff = new Date()
		cutoff.setDate(cutoff.getDate() - retentionDays)
		return cutoff
	}

	async run(sql: SQL, options: RunOptions = {}): Promise<OrchestratorStats> {
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
			: await this.discoverTables(sql)

		stats.tables = tables

		// Process each table
		for (const table of tables) {
			try {
				const tableStats = await this.processTable(sql, table, options)
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
		sql: SQL,
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

		if (options.dryRun) {
			// Dry run: just count
			const cutoff = this.getRetentionCutoff(tableName)
			const _oldRecords = await sql`
        SELECT COUNT(*) as count
        FROM audit_log
        WHERE table_name = ${tableName}
          AND changed_at < ${cutoff}
          AND archived_at IS NULL
      `
			// Don't actually process
			stats.durationMs = Date.now() - startTime
			return stats
		}

		// Create archiver
		const { PgHistoryArchiver } = await import('./PgHistoryArchiver')
		const archiver = new PgHistoryArchiver({
			sql,
			s3: this.config.s3,
			retention: this.config.retention,
			gracePeriod: this.config.gracePeriod,
			batchSize: this.config.batchSize,
		})

		// Archive old records
		const cutoff = this.getRetentionCutoff(tableName)
		let archived = 0
		let hasMore = true

		while (hasMore) {
			const records = await archiver.queryOldRecords(
				tableName,
				cutoff,
				this.config.batchSize,
			)

			if (records.length === 0) {
				hasMore = false
				break
			}

			if (options.skipS3Upload) {
				// Skip actual S3 upload in test, just mark as archived
				for (const record of records) {
					await sql`
            UPDATE audit_log
            SET archived_at = NOW()
            WHERE id = ${record.id}
          `
				}
			} else {
				// Real archival with S3 upload
				// TODO: Implement when S3 is available
				throw new Error('S3 upload not yet implemented in orchestrator')
			}

			archived += records.length
		}

		stats.recordsArchived = archived

		// Soft delete archived records past grace period
		const softDeleted = await archiver.softDeleteArchived(tableName)
		stats.recordsSoftDeleted = softDeleted

		// Hard delete soft-deleted records past grace period
		const hardDeleted = await archiver.hardDeletePurged(tableName)
		stats.recordsHardDeleted = hardDeleted

		stats.durationMs = Date.now() - startTime
		return stats
	}
}
