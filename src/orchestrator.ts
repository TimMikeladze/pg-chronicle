import type { Pool } from 'pg'
import { consoleLogger, type Logger } from './logger'
import { updateArchivalStats } from './schema'
import type {
	OrchestratorConfig,
	OrchestratorStats,
	RetentionConfig,
	RunOptions,
	S3Config,
	TableStats,
} from './types'

// Fixed namespace for advisory locks to avoid collisions with other lock users.
// We prefix the table name with 'pg-history:' before hashing so two different
// applications using hashtext() on raw table names cannot collide with us.
const ADVISORY_LOCK_NAMESPACE = 73_616_468 // arbitrary stable int32
const ADVISORY_LOCK_KEY_PREFIX = 'pg-history:'

export class Orchestrator {
	private s3Config: S3Config
	private retentionConfig: RetentionConfig
	private gracePeriod: number
	private batchSize: number
	private logger: Logger

	/**
	 * Construct an Orchestrator.
	 *
	 * Prefers the config-object form to avoid positional argument mix-ups.
	 * The legacy 4-positional form is still accepted for backwards compatibility.
	 */
	constructor(config: OrchestratorConfig)
	constructor(
		s3Config: S3Config,
		retentionConfig: RetentionConfig,
		gracePeriod: number,
		batchSize: number,
	)
	constructor(
		configOrS3: OrchestratorConfig | S3Config,
		retentionConfig?: RetentionConfig,
		gracePeriod?: number,
		batchSize?: number,
	) {
		if (
			'retention' in configOrS3 &&
			'gracePeriod' in configOrS3 &&
			'batchSize' in configOrS3
		) {
			// Config-object form
			const cfg = configOrS3 as OrchestratorConfig
			this.s3Config = cfg.s3
			this.retentionConfig = cfg.retention
			this.gracePeriod = cfg.gracePeriod
			this.batchSize = cfg.batchSize
			this.logger = cfg.logger ?? consoleLogger
		} else {
			// Legacy 4-positional form
			this.s3Config = configOrS3 as S3Config
			this.retentionConfig = retentionConfig as RetentionConfig
			this.gracePeriod = gracePeriod as number
			this.batchSize = batchSize as number
			this.logger = consoleLogger
		}
	}

	async discoverTables(pool: Pool): Promise<string[]> {
		// Query pg_trigger to find tables with pg-history audit triggers.
		// We require BOTH:
		//   1. The trigger name matches 'audit_trigger_%'
		//   2. The trigger's function name matches 'audit_trigger_func_%'
		// to avoid picking up unrelated triggers that happen to share our prefix.
		// Use relname (unqualified) so returned names match retentionConfig.tables
		// keys and validateTableName expectations.
		const result = await pool.query(`
      SELECT DISTINCT
        c.relname AS table_name
      FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgname LIKE 'audit_trigger_%'
        AND p.proname LIKE 'audit_trigger_func_%'
        AND NOT t.tgisinternal
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

				// Update archival stats OUTSIDE the advisory lock (held by processTable).
				// updateArchivalStats scans audit_log with FILTER aggregates which can be
				// expensive on large tables — we don't want to hold the lock for it.
				// Also skip in dry-run mode since nothing actually changed.
				if (!options.dryRun) {
					try {
						const retentionDays =
							this.retentionConfig.tables?.[table] ||
							this.retentionConfig.default
						await updateArchivalStats(
							pool,
							table,
							retentionDays,
							this.gracePeriod,
						)
					} catch (error) {
						stats.errors.push({
							table,
							operation: 'update_stats',
							error: error instanceof Error ? error.message : String(error),
						})
					}
				}
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
		// NOTE: This holds a pool connection for the entire duration of table processing
		// (archive + soft delete + hard delete). Ensure the pool max is at least 2
		// (1 for the lock + 1 for queries). Tables are processed sequentially.
		const lockKey = `${ADVISORY_LOCK_KEY_PREFIX}${tableName}`
		const lockClient = await pool.connect()
		try {
			const lockResult = await lockClient.query(
				`SELECT pg_try_advisory_lock($1, hashtext($2))`,
				[ADVISORY_LOCK_NAMESPACE, lockKey],
			)
			const acquired = lockResult.rows[0]?.pg_try_advisory_lock === true
			if (!acquired) {
				this.logger.info('Skipping table — another instance is processing it', {
					table: tableName,
				})
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

				this.logger.info('DRY RUN', {
					table: tableName,
					wouldArchive: Number(archiveCount.rows[0]?.count || 0),
					wouldSoftDelete: Number(softDeleteCount.rows[0]?.count || 0),
					wouldHardDelete: Number(hardDeleteCount.rows[0]?.count || 0),
				})

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
				logger: this.logger,
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
						this.logger.info('Batch archived', {
							table: tableName,
							batch: batchNumber,
							records: batchResult.recordCount,
							s3Path: batchResult.s3Path,
						})
					}
				} catch (error) {
					this.logger.error('Batch failed', {
						table: tableName,
						batch: batchNumber,
						err: error,
					})
					throw error
				}
			}

			// Soft delete archived records past grace period (in batches)
			this.logger.info('Soft deleting records past grace period', {
				table: tableName,
			})
			let totalSoftDeleted = 0
			let softDeleteHasMore = true

			while (softDeleteHasMore) {
				const softDeleted = await archiver.softDeleteArchived(tableName)
				totalSoftDeleted += softDeleted

				if (softDeleted === 0) {
					softDeleteHasMore = false
				} else {
					this.logger.info('Soft deleted batch', {
						table: tableName,
						records: softDeleted,
					})
				}
			}

			stats.recordsSoftDeleted = totalSoftDeleted

			// Hard delete soft-deleted records past grace period
			this.logger.info('Hard deleting soft-deleted records', {
				table: tableName,
			})
			let totalHardDeleted = 0
			let hardDeleteHasMore = true

			while (hardDeleteHasMore) {
				const hardDeleted = await archiver.hardDeletePurged(tableName)
				totalHardDeleted += hardDeleted

				if (hardDeleted === 0) {
					hardDeleteHasMore = false
				} else {
					this.logger.info('Hard deleted batch', {
						table: tableName,
						records: hardDeleted,
					})
				}
			}

			stats.recordsHardDeleted = totalHardDeleted

			stats.durationMs = Date.now() - startTime
			return stats
		} finally {
			// Release the advisory lock and return connection to pool
			await lockClient
				.query(`SELECT pg_advisory_unlock($1, hashtext($2))`, [
					ADVISORY_LOCK_NAMESPACE,
					lockKey,
				])
				.catch(() => {})
			lockClient.release()
		}
	}
}
