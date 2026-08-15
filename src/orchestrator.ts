import type { Pool } from 'pg'
import pg from 'pg'
import { consoleLogger, type Logger } from './logger'
import { validateIdentifier } from './pg-chronicle-validators'
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
// We prefix the table name with 'pg-chronicle:' before hashing so two different
// applications using hashtext() on raw table names cannot collide with us.
const ADVISORY_LOCK_NAMESPACE = 73_616_468 // arbitrary stable int32
const ADVISORY_LOCK_KEY_PREFIX = 'pg-chronicle:'

export class Orchestrator {
	private s3Config: S3Config
	private retentionConfig: RetentionConfig
	private gracePeriod: number
	private batchSize: number
	private maxBatchBytes: number | undefined
	private staleClaimMinutes: number | undefined
	private logger: Logger
	private lockConnectionString: string | undefined

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
		// Disambiguate by `retention` + `gracePeriod` — `batchSize` is now optional
		// on OrchestratorConfig and can't be required here without misrouting
		// config-object callers that omit it into the legacy positional path.
		if ('retention' in configOrS3 && 'gracePeriod' in configOrS3) {
			// Config-object form
			const cfg = configOrS3 as OrchestratorConfig
			this.s3Config = cfg.s3
			this.retentionConfig = cfg.retention
			this.gracePeriod = cfg.gracePeriod
			this.batchSize = cfg.batchSize ?? 10_000
			this.maxBatchBytes = cfg.maxBatchBytes
			this.staleClaimMinutes = cfg.staleClaimMinutes
			this.logger = cfg.logger ?? consoleLogger
			this.lockConnectionString = cfg.lockConnectionString
		} else {
			// Legacy 4-positional form
			this.s3Config = configOrS3 as S3Config
			this.retentionConfig = retentionConfig as RetentionConfig
			this.gracePeriod = gracePeriod as number
			this.batchSize = batchSize as number
			this.logger = consoleLogger
		}
	}

	/**
	 * Create a standalone pg.Client for advisory lock management.
	 *
	 * A standalone client does NOT consume a pool slot, so the pool remains
	 * fully available for archival queries even while S3 uploads are in flight.
	 * Session-level advisory locks are tied to the backend connection: as long
	 * as this client stays connected the lock is held; calling client.end()
	 * releases both the lock and the TCP connection.
	 *
	 * When `lockConnectionString` is provided in the constructor config, it is
	 * used directly and the pool is not inspected. This is the recommended path
	 * for production deployments where you need certainty that the lock client
	 * connects to the same database as the pool.
	 *
	 * Without `lockConnectionString`, we fall back to reading `pool.options` via
	 * an internal cast (not part of the public @types/pg API). If those fields
	 * are all undefined, pg.Client falls back to PGHOST/PGUSER/PGPASSWORD env
	 * vars — the same fallback the pool itself used.
	 */
	private async createLockClient(pool: Pool): Promise<pg.Client> {
		if (this.lockConnectionString) {
			const client = new pg.Client({
				connectionString: this.lockConnectionString,
			})
			this.attachClientErrorHandler(client)
			await client.connect()
			return client
		}
		const poolOpts =
			(
				pool as unknown as {
					options?: pg.ClientConfig & { connectionString?: string }
				}
			).options ?? {}
		if (!poolOpts.connectionString && !poolOpts.host && !poolOpts.database) {
			this.logger.warn(
				'lockConnectionString not set and pool options are empty — ' +
					'lock client will connect using PGHOST/PGUSER/PGPASSWORD env vars. ' +
					'Set lockConnectionString in OrchestratorConfig to silence this warning.',
			)
		}
		const client = new pg.Client({
			connectionString: poolOpts.connectionString,
			host: poolOpts.host,
			port: poolOpts.port,
			user: poolOpts.user,
			password: poolOpts.password,
			database: poolOpts.database,
			ssl: poolOpts.ssl,
		})
		this.attachClientErrorHandler(client)
		await client.connect()
		return client
	}

	/**
	 * Attach an 'error' listener to a standalone lock client. A node-postgres
	 * Client is an EventEmitter that emits 'error' on any backend/connection
	 * fatality (idle timeout, server-side termination, failover, network reset).
	 * Because this client is held open across long S3 uploads, an 'error' with
	 * no listener would be re-thrown by Node and crash the entire process. We
	 * log and swallow — the lock is released when the connection dies, and the
	 * surrounding query will reject and abort the run cleanly.
	 */
	private attachClientErrorHandler(client: pg.Client): void {
		client.on('error', (err) => {
			this.logger.error('Advisory-lock client connection error', { err })
		})
	}

	async discoverTables(pool: Pool): Promise<string[]> {
		// Query pg_trigger to find tables with pg-chronicle audit triggers.
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
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgname LIKE 'audit_trigger_%'
        AND p.proname LIKE 'audit_trigger_func_%'
        AND NOT t.tgisinternal
        AND n.nspname = current_schema()
      ORDER BY table_name
    `)

		return result.rows.map((row: { table_name: string }) => row.table_name)
	}

	/**
	 * Retention cutoff for a table, computed from the **Node** clock.
	 *
	 * `run()` deliberately does NOT use this: it derives both cutoffs from the
	 * database clock, so archival cannot disagree with `softDeleteArchived` /
	 * `hardDeletePurged` (which do their interval arithmetic in SQL) under
	 * app-server/DB clock skew. This method remains for callers driving
	 * `PgChronicleArchiver.processBatch` themselves, and for inspecting the
	 * configured policy — if the two ever need to agree exactly, ask the
	 * database, not this.
	 */
	getRetentionCutoff(tableName: string): Date {
		const retentionDays =
			this.retentionConfig.tables?.[tableName] ?? this.retentionConfig.default
		if (!Number.isFinite(retentionDays) || retentionDays < 1) {
			throw new Error(
				`Invalid retention days for table "${tableName}": ${retentionDays}. Must be a positive integer.`,
			)
		}
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
			totalOrphanFilesDeleted: 0,
			totalArchivesPruned: 0,
			errors: [],
			durationMs: 0,
		}

		// Validate targetTable identifier format. We deliberately do NOT require
		// targetTable to be in discoverTables() — operators may run the
		// orchestrator against tables whose triggers haven't been set up yet
		// (audit_log rows present from external triggers, dry-run scenarios).
		// The archival queries are scoped by WHERE table_name = $1 so a
		// misspelled name is a safe no-op, not data corruption.
		if (options.targetTable) {
			validateIdentifier(options.targetTable, 'table')
		}
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
				stats.totalOrphanFilesDeleted += tableStats.orphanFilesDeleted
				stats.totalArchivesPruned += tableStats.archivesPruned

				// Update archival stats OUTSIDE the advisory lock (held by processTable).
				// updateArchivalStats scans audit_log with FILTER aggregates which can be
				// expensive on large tables — we don't want to hold the lock for it.
				// Skip in dry-run mode (nothing changed) and when this table was
				// skipped due to lock contention (another instance is already
				// processing it and will update the stats — running the expensive
				// full-partition scan + upsert here would just waste I/O and contend
				// on the same stats row).
				if (!options.dryRun && !tableStats.skipped) {
					try {
						const retentionDays =
							this.retentionConfig.tables?.[table] ??
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
			orphanFilesDeleted: 0,
			archivesPruned: 0,
			durationMs: 0,
		}

		// Acquire advisory lock to prevent concurrent processing of the same table.
		// The lock is session-level: it persists as long as lockClient stays connected.
		// We use a standalone pg.Client (not a pool connection) so the pool remains
		// fully available for archival queries throughout S3 I/O.
		const lockKey = `${ADVISORY_LOCK_KEY_PREFIX}${tableName}`
		const lockClient = await this.createLockClient(pool)
		try {
			// hashtextextended returns int8 (64-bit) — wider collision space than
			// hashtext's int4. The single-arg form pg_try_advisory_lock(bigint)
			// uses the full 64-bit lock address. Seed includes the namespace so
			// the orchestrator's locks remain partitioned from any other caller
			// that uses pg_try_advisory_lock with a different seed convention.
			const lockResult = await lockClient.query(
				`SELECT pg_try_advisory_lock(hashtextextended($1, $2::bigint))`,
				[lockKey, ADVISORY_LOCK_NAMESPACE],
			)
			const acquired = lockResult.rows[0]?.pg_try_advisory_lock === true
			if (!acquired) {
				this.logger.info('Skipping table — another instance is processing it', {
					table: tableName,
				})
				await lockClient.end().catch(() => {})
				stats.durationMs = Date.now() - startTime
				stats.skipped = true
				return stats
			}
		} catch (error) {
			await lockClient.end().catch(() => {})
			throw error
		}

		try {
			// Detect schema for qualified table references
			const schemaResult = await lockClient.query(
				'SELECT current_schema() as schema',
			)
			const schema = schemaResult.rows[0]?.schema || 'public'
			validateIdentifier(schema, 'schema')
			const auditTable = `"${schema}"."audit_log"`

			// Compute both cutoffs from the DB clock to avoid Node.js / PostgreSQL
			// clock-skew. The DB-side interval arithmetic is identical to what
			// softDeleteArchived / hardDeletePurged execute, so dry-run counts and
			// actual archival operate on the same logical boundary.
			const retentionDays =
				this.retentionConfig.tables?.[tableName] ?? this.retentionConfig.default
			if (!Number.isFinite(retentionDays) || retentionDays < 1) {
				throw new Error(
					`Invalid retention days for table "${tableName}": ${retentionDays}. Must be a positive integer.`,
				)
			}
			const clockResult = await lockClient.query(
				`SELECT NOW() - ($1 * INTERVAL '1 day') AS cutoff,
				        NOW() - ($2 * INTERVAL '1 day') AS grace_cutoff`,
				[retentionDays, this.gracePeriod],
			)
			const cutoff: Date = clockResult.rows[0].cutoff
			const graceCutoff: Date = clockResult.rows[0].grace_cutoff

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
					[tableName, graceCutoff],
				)

				const hardDeleteCount = await lockClient.query(
					`SELECT COUNT(*) as count
					FROM ${auditTable}
					WHERE table_name = $1
						AND soft_deleted_at IS NOT NULL
						AND soft_deleted_at < $2`,
					[tableName, graceCutoff],
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
			const { PgChronicleArchiver } = await import('./PgChronicleArchiver')
			const archiver = new PgChronicleArchiver({
				pool,
				s3: this.s3Config,
				retention: this.retentionConfig,
				gracePeriod: this.gracePeriod,
				batchSize: this.batchSize,
				maxBatchBytes: this.maxBatchBytes,
				staleClaimMinutes: this.staleClaimMinutes,
				logger: this.logger,
			})
			// Schema is already initialized by callers that use the archiver
			// directly; mark it ready here so reapStaleClaims/processBatch don't
			// re-run setup under the advisory lock. The PgChronicle.setup() call in
			// server.ts and standalone scripts handles the actual DDL.
			await archiver.setup()

			// Reap stale claims left by previously-crashed workers before the
			// batch loop so abandoned rows return to the pending pool and get
			// re-claimed in this run.
			try {
				const reaped = await archiver.reapStaleClaims()
				if (reaped > 0) {
					this.logger.info('Reaped stale claims', {
						table: tableName,
						count: reaped,
					})
				}
			} catch (error) {
				this.logger.warn('Failed to reap stale claims', {
					table: tableName,
					err: error,
				})
			}

			// Archive old records in batches
			let hasMore = true
			let batchNumber = 0
			// Bound contention retries so a pathological repeat can't loop forever.
			let contendedRetries = 0
			const MAX_CONTENDED_RETRIES = 5

			while (hasMore) {
				batchNumber++

				try {
					const batchResult = await archiver.processBatch(tableName, cutoff)

					stats.recordsArchived += batchResult.recordCount

					if (
						batchResult.status === 'reaped' ||
						batchResult.status === 'contended'
					) {
						// Two ways a batch can produce nothing while work remains:
						//   reaped     a reaper reset our claim mid-upload
						//   contended  another archiver claimed the rows we peeked at
						// Neither means "no work left" — keep looping so the rows get
						// picked up, but cap retries to avoid spinning against a peer
						// that is steadily out-racing us (it is making progress too).
						contendedRetries++
						if (contendedRetries > MAX_CONTENDED_RETRIES) {
							this.logger.warn(
								'Aborting table archival after repeated claim races; remaining rows will be picked up next run',
								{
									table: tableName,
									retries: contendedRetries,
									lastStatus: batchResult.status,
								},
							)
							hasMore = false
						}
					} else if (batchResult.recordCount === 0) {
						hasMore = false
					} else {
						contendedRetries = 0
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

			// Optional maintenance phases. Both are opt-in because they LIST or
			// DELETE in S3 and are meant to run on a slower cadence than archival.
			// They run last so a failure here cannot cost us the archival work
			// already committed above — hence the try/catch rather than a throw.
			//
			// Deliberately INSIDE the table's advisory lock. That extends how long
			// the lock is held (an orphan sweep LISTs the whole table prefix), but
			// it is what makes the sweep safe: no other instance can be mid-upload
			// for this table, so the only thing protecting an in-flight object is
			// not the age window alone.
			if (options.cleanupOrphans) {
				try {
					const cleanupOpts =
						typeof options.cleanupOrphans === 'object'
							? options.cleanupOrphans
							: {}
					stats.orphanFilesDeleted = await archiver.cleanupOrphanedFiles(
						tableName,
						cleanupOpts,
					)
					if (stats.orphanFilesDeleted > 0) {
						this.logger.info('Deleted orphaned archive files', {
							table: tableName,
							count: stats.orphanFilesDeleted,
						})
					}
				} catch (error) {
					this.logger.warn('Orphan cleanup failed', {
						table: tableName,
						err: error,
					})
				}
			}

			if (options.pruneArchivesOlderThanDays !== undefined) {
				try {
					const days = options.pruneArchivesOlderThanDays
					if (!Number.isFinite(days) || days < 1) {
						throw new Error(
							`pruneArchivesOlderThanDays must be a positive number of days (got: ${days})`,
						)
					}
					// DB clock again, for the same reason the retention cutoffs use it.
					const pruneResult = await lockClient.query(
						`SELECT NOW() - ($1 * INTERVAL '1 day') AS cutoff`,
						[days],
					)
					stats.archivesPruned = await archiver.pruneArchive(
						tableName,
						pruneResult.rows[0].cutoff as Date,
					)
					if (stats.archivesPruned > 0) {
						this.logger.info('Pruned archive files past compliance retention', {
							table: tableName,
							count: stats.archivesPruned,
							olderThanDays: days,
						})
					}
				} catch (error) {
					this.logger.warn('Archive prune failed', {
						table: tableName,
						err: error,
					})
				}
			}

			stats.durationMs = Date.now() - startTime
			return stats
		} finally {
			// Unlock before disconnecting (best-effort; the lock also releases when
			// the connection closes, so a failure here is not catastrophic).
			await lockClient
				.query(`SELECT pg_advisory_unlock(hashtextextended($1, $2::bigint))`, [
					lockKey,
					ADVISORY_LOCK_NAMESPACE,
				])
				.catch(() => {})
			// end() closes the TCP connection and implicitly releases the session lock
			await lockClient.end().catch(() => {})
		}
	}
}
