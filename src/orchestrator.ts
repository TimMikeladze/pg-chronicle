import type { Pool } from 'pg'
import { updateArchivalStats } from './schema'
import type {
	OrchestratorStats,
	RetentionConfig,
	RunOptions,
	S3Config,
	TableStats,
} from './types'

// Fixed namespace for advisory locks to avoid collisions with other lock users
const ADVISORY_LOCK_NAMESPACE = 73_616_468 // arbitrary stable int32

export class Orchestrator {
	constructor(
		private s3Config: S3Config,
		private retentionConfig: RetentionConfig,
		private gracePeriod: number,
		private batchSize: number,
	) {}

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
			this.retentionConfig.tables?.[tableName] || this.retentionConfig.default
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

		// Acquire advisory lock to prevent concurrent processing of the same table.
		// The lock is session-level: it persists as long as lockClient stays connected.
		// We keep lockClient alive (not released) throughout processing so the lock holds.
		const lockClient = await pool.connect()
		try {
			const lockResult = await lockClient.query(
				`SELECT pg_try_advisory_lock($1, hashtext($2))`,
				[ADVISORY_LOCK_NAMESPACE, tableName],
			)
			const acquired = lockResult.rows[0]?.pg_try_advisory_lock === true
			if (!acquired) {
				console.log(
					`[pg-history] Skipping ${tableName} — another instance is processing it`,
				)
				lockClient.release()
				stats.durationMs = Date.now() - startTime
				return stats
			}
		} catch (error) {
			lockClient.release()
			throw error
		}

		try {
			// Detect schema for qualified table references
			const schemaResult = await lockClient.query(
				'SELECT current_schema() as schema',
			)
			const schema = schemaResult.rows[0]?.schema || 'public'
			const auditTable = `"${schema}"."audit_log"`

			const cutoff = this.getRetentionCutoff(tableName)
			const gracePeriodDate = new Date()
			gracePeriodDate.setDate(gracePeriodDate.getDate() - this.gracePeriod)

			if (options.dryRun) {
				// Use lockClient for dry-run queries to avoid extra pool checkouts
				const archiveCount = await lockClient.query(
					`SELECT COUNT(*) as count
					FROM ${auditTable}
					WHERE table_name = $1
						AND changed_at < $2
						AND archived_at IS NULL`,
					[tableName, cutoff],
				)

				const softDeleteCount = await lockClient.query(
					`SELECT COUNT(*) as count
					FROM ${auditTable}
					WHERE table_name = $1
						AND archived_at IS NOT NULL
						AND archived_at < $2
						AND soft_deleted_at IS NULL
						AND s3_path IS NOT NULL`,
					[tableName, gracePeriodDate],
				)

				const hardDeleteCount = await lockClient.query(
					`SELECT COUNT(*) as count
					FROM ${auditTable}
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
				s3: this.s3Config,
				retention: this.retentionConfig,
				gracePeriod: this.gracePeriod,
				batchSize: this.batchSize,
			})

			// Archive old records in batches
			let hasMore = true
			let batchNumber = 0

			while (hasMore) {
				batchNumber++

				try {
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
					console.error(
						`  Batch ${batchNumber} failed: ${error instanceof Error ? error.message : String(error)}`,
					)
					throw error
				}
			}

			// Soft delete archived records past grace period (in batches)
			console.log(`  Soft deleting records past grace period...`)
			let totalSoftDeleted = 0
			let softDeleteHasMore = true

			while (softDeleteHasMore) {
				const softDeleted = await archiver.softDeleteArchived(tableName)
				totalSoftDeleted += softDeleted

				if (softDeleted === 0) {
					softDeleteHasMore = false
				} else {
					console.log(`  Soft deleted ${softDeleted} records`)
				}
			}

			stats.recordsSoftDeleted = totalSoftDeleted

			// Hard delete soft-deleted records past grace period
			console.log(`  Hard deleting soft-deleted records...`)
			let totalHardDeleted = 0
			let hardDeleteHasMore = true

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

			const retentionDays =
				this.retentionConfig.tables?.[tableName] || this.retentionConfig.default
			await updateArchivalStats(
				pool,
				tableName,
				retentionDays,
				this.gracePeriod,
			)

			stats.durationMs = Date.now() - startTime
			return stats
		} finally {
			// Release the advisory lock and return connection to pool
			await lockClient
				.query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [
					ADVISORY_LOCK_NAMESPACE,
					tableName,
				])
				.catch(() => {})
			lockClient.release()
		}
	}
}
