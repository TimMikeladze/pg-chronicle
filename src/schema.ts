import type { Pool } from 'pg'
import { validateIdentifier } from './pg-history-validators'

// Cache schema per pool instance to avoid repeated round-trips.
// The schema does not change during a session; keying by pool avoids
// cross-contamination when multiple pools are used in the same process (tests).
const schemaCache = new WeakMap<Pool, string>()

async function getSchemaPrefix(pool: Pool): Promise<string> {
	const cached = schemaCache.get(pool)
	if (cached) return cached

	const result = await pool.query('SELECT current_schema() as schema')
	const schema = result.rows[0]?.schema || 'public'
	validateIdentifier(schema, 'schema')
	const prefix = `"${schema}"`
	schemaCache.set(pool, prefix)
	return prefix
}

export async function setupArchiverSchema(pool: Pool): Promise<void> {
	const s = await getSchemaPrefix(pool)
	const auditTable = `${s}."audit_log"`
	const metadataTable = `${s}."audit_archive_metadata"`
	const statsTable = `${s}."audit_archival_stats"`

	// Fast path: if all expected columns + tables + indexes already exist,
	// skip the 10+ DDL roundtrips. Critical on serverless cold starts where
	// every roundtrip lands on the first request's latency budget. Indexes
	// are checked too — without them, archival queries fall back to seq
	// scans and the perf regression is invisible without an EXPLAIN.
	const probe = await pool.query(
		`SELECT
       (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'audit_log'
          AND column_name IN ('archived_at', 's3_path', 'soft_deleted_at', 'claim_id', 'claimed_at')) AS col_count,
       (SELECT COUNT(*) FROM information_schema.tables
        WHERE table_schema = current_schema()
          AND table_name IN ('audit_archive_metadata', 'audit_archival_stats')) AS tbl_count,
       (SELECT COUNT(*) FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname IN (
            'idx_audit_log_archival',
            'idx_audit_log_unclaimed',
            'idx_audit_log_claimed',
            'idx_audit_log_soft_delete',
            'idx_audit_log_hard_delete',
            'idx_archive_metadata_table_date',
            'idx_archival_stats_updated'
          )) AS idx_count`,
	)
	const colCount = Number(probe.rows[0]?.col_count ?? 0)
	const tblCount = Number(probe.rows[0]?.tbl_count ?? 0)
	const idxCount = Number(probe.rows[0]?.idx_count ?? 0)
	if (colCount === 5 && tblCount === 2 && idxCount === 7) {
		return
	}

	// Add archived_at column to audit_log
	await pool.query(`
    ALTER TABLE ${auditTable}
      ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ
  `)

	// Add s3_path to track where record is backed up
	await pool.query(`
    ALTER TABLE ${auditTable}
      ADD COLUMN IF NOT EXISTS s3_path TEXT
  `)

	// Add soft_deleted_at column
	await pool.query(`
    ALTER TABLE ${auditTable}
      ADD COLUMN IF NOT EXISTS soft_deleted_at TIMESTAMPTZ
  `)

	// Claim columns implement non-blocking archival: a worker UPDATEs claim_id
	// on a batch of rows in one short transaction, releases the lock, performs
	// the slow S3 upload outside any transaction, then UPDATEs archived_at in a
	// second short transaction. Crashed workers leave stale claims that
	// PgHistoryArchiver.reapStaleClaims() resets via claimed_at < NOW() - interval.
	await pool.query(`
    ALTER TABLE ${auditTable}
      ADD COLUMN IF NOT EXISTS claim_id UUID
  `)
	await pool.query(`
    ALTER TABLE ${auditTable}
      ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ
  `)

	// Create composite index for archival queries
	await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_archival
      ON ${auditTable}(table_name, changed_at)
      WHERE archived_at IS NULL
  `)

	// CREATE INDEX CONCURRENTLY avoids the ACCESS EXCLUSIVE lock during deploy,
	// but Postgres rejects it on partitioned parent tables. Detect partitioning
	// and fall back to plain CREATE INDEX (which cascades to partitions and
	// blocks writes — acceptable for partitioned tables since DDL is rare).
	const partitionCheck = await pool.query(
		`SELECT c.relkind = 'p' AS is_partitioned
       FROM pg_class c
       JOIN pg_namespace n ON c.relnamespace = n.oid
       WHERE n.nspname = current_schema() AND c.relname = 'audit_log'`,
	)
	const isPartitioned = partitionCheck.rows[0]?.is_partitioned === true
	const concurrently = isPartitioned ? '' : 'CONCURRENTLY'

	// Partial index for the unclaimed-row scan that processBatch performs.
	await pool.query(`
    CREATE INDEX ${concurrently} IF NOT EXISTS idx_audit_log_unclaimed
      ON ${auditTable}(table_name, changed_at)
      WHERE archived_at IS NULL AND claim_id IS NULL
  `)

	// Index for the reaper: scan stale claims by claimed_at.
	await pool.query(`
    CREATE INDEX ${concurrently} IF NOT EXISTS idx_audit_log_claimed
      ON ${auditTable}(claimed_at)
      WHERE claim_id IS NOT NULL AND archived_at IS NULL
  `)

	// Create index for soft delete queries
	await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_soft_delete
      ON ${auditTable}(archived_at)
      WHERE archived_at IS NOT NULL AND soft_deleted_at IS NULL
  `)

	// Create index for hard delete queries
	await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_hard_delete
      ON ${auditTable}(soft_deleted_at)
      WHERE soft_deleted_at IS NOT NULL
  `)

	// Create metadata tracking table
	await pool.query(`
    CREATE TABLE IF NOT EXISTS ${metadataTable} (
      id SERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      archive_date DATE NOT NULL,
      s3_path TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      file_size BIGINT NOT NULL,
      archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(s3_path)
    )
  `)

	// Create indexes on metadata table
	await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_archive_metadata_table_date
      ON ${metadataTable}(table_name, archive_date)
  `)

	// Create lightweight stats table to avoid scanning audit_log
	await pool.query(`
    CREATE TABLE IF NOT EXISTS ${statsTable} (
      table_name TEXT PRIMARY KEY,
      records_pending_archive BIGINT NOT NULL DEFAULT 0,
      records_pending_soft_delete BIGINT NOT NULL DEFAULT 0,
      records_pending_hard_delete BIGINT NOT NULL DEFAULT 0,
      oldest_unarchived_record TIMESTAMPTZ,
      last_updated TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

	// Create index for stat queries
	await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_archival_stats_updated
      ON ${statsTable}(last_updated)
  `)
}

/**
 * Update archival stats for a table.
 * Scans audit_log rows matching the table with FILTER aggregates. On large tables
 * this can be expensive — call after archival runs, not on every request. The partial
 * indexes (idx_audit_log_archival, idx_audit_log_soft_delete, idx_audit_log_hard_delete)
 * help but don't eliminate the scan cost.
 */
export async function updateArchivalStats(
	pool: Pool,
	tableName: string,
	retentionDays: number,
	gracePeriodDays: number,
): Promise<void> {
	const retentionCutoff = new Date()
	retentionCutoff.setDate(retentionCutoff.getDate() - retentionDays)

	const gracePeriodCutoff = new Date()
	gracePeriodCutoff.setDate(gracePeriodCutoff.getDate() - gracePeriodDays)

	const s = await getSchemaPrefix(pool)
	const auditTable = `${s}."audit_log"`
	const statsTable = `${s}."audit_archival_stats"`

	// Get counts in a single query using FILTER aggregates.
	// Each FILTER is self-contained — no outer WHERE pre-filtering is needed and
	// adding one creates subtle correctness bugs (e.g. pending_soft_delete rows
	// may not satisfy changed_at < retentionCutoff but still need counting).
	// This scans the full table partition, which is acceptable: this method runs
	// outside the advisory lock and is a reporting-only operation.
	const result = await pool.query(
		`SELECT
      COUNT(*) FILTER (WHERE archived_at IS NULL AND changed_at < $2) as pending_archive,
      COUNT(*) FILTER (WHERE archived_at IS NOT NULL AND archived_at < $3 AND soft_deleted_at IS NULL AND s3_path IS NOT NULL) as pending_soft_delete,
      COUNT(*) FILTER (WHERE soft_deleted_at IS NOT NULL AND soft_deleted_at < $3) as pending_hard_delete,
      MIN(changed_at) FILTER (WHERE archived_at IS NULL) as oldest_unarchived
    FROM ${auditTable}
    WHERE table_name = $1`,
		[tableName, retentionCutoff, gracePeriodCutoff],
	)

	// Destructure by name so a future query shape change doesn't silently
	// remap columns to the wrong INSERT slots.
	const {
		pending_archive = 0,
		pending_soft_delete = 0,
		pending_hard_delete = 0,
		oldest_unarchived = null,
	} = (result.rows[0] ?? {}) as {
		pending_archive?: number | string
		pending_soft_delete?: number | string
		pending_hard_delete?: number | string
		oldest_unarchived?: Date | null
	}

	// Upsert stats
	await pool.query(
		`INSERT INTO ${statsTable} (
      table_name,
      records_pending_archive,
      records_pending_soft_delete,
      records_pending_hard_delete,
      oldest_unarchived_record,
      last_updated
    ) VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (table_name) DO UPDATE SET
      records_pending_archive = EXCLUDED.records_pending_archive,
      records_pending_soft_delete = EXCLUDED.records_pending_soft_delete,
      records_pending_hard_delete = EXCLUDED.records_pending_hard_delete,
      oldest_unarchived_record = EXCLUDED.oldest_unarchived_record,
      last_updated = NOW()`,
		[
			tableName,
			pending_archive,
			pending_soft_delete,
			pending_hard_delete,
			oldest_unarchived,
		],
	)
}

/**
 * Get archival stats for all tables
 * Fast query - no audit_log scan required
 */
export async function getArchivalStats(pool: Pool): Promise<
	Array<{
		tableName: string
		recordsPendingArchive: number
		recordsPendingSoftDelete: number
		recordsPendingHardDelete: number
		oldestUnarchivedRecord: Date | null
		lastUpdated: Date
	}>
> {
	const s = await getSchemaPrefix(pool)
	const statsTable = `${s}."audit_archival_stats"`

	const result = await pool.query(`
    SELECT
      table_name,
      records_pending_archive,
      records_pending_soft_delete,
      records_pending_hard_delete,
      oldest_unarchived_record,
      last_updated
    FROM ${statsTable}
    ORDER BY records_pending_archive DESC
  `)

	return result.rows.map((row) => ({
		tableName: row.table_name,
		recordsPendingArchive: Number.parseInt(row.records_pending_archive, 10),
		recordsPendingSoftDelete: Number.parseInt(
			row.records_pending_soft_delete,
			10,
		),
		recordsPendingHardDelete: Number.parseInt(
			row.records_pending_hard_delete,
			10,
		),
		oldestUnarchivedRecord: row.oldest_unarchived_record,
		lastUpdated: row.last_updated,
	}))
}

export async function teardownArchiverSchema(pool: Pool): Promise<void> {
	const s = await getSchemaPrefix(pool)
	const auditTable = `${s}."audit_log"`
	const statsTable = `${s}."audit_archival_stats"`
	const metadataTable = `${s}."audit_archive_metadata"`

	// Drop stats table
	await pool.query(`DROP TABLE IF EXISTS ${statsTable} CASCADE`)

	// Drop metadata table
	await pool.query(`DROP TABLE IF EXISTS ${metadataTable} CASCADE`)

	// Drop archiver-owned indexes explicitly before dropping their columns.
	// We avoid CASCADE on DROP COLUMN so that user-defined indexes/views/
	// constraints that reference these columns surface as a loud error
	// instead of being silently destroyed.
	await pool.query(`DROP INDEX IF EXISTS ${s}.idx_audit_log_archival`)
	await pool.query(`DROP INDEX IF EXISTS ${s}.idx_audit_log_unclaimed`)
	await pool.query(`DROP INDEX IF EXISTS ${s}.idx_audit_log_claimed`)
	await pool.query(`DROP INDEX IF EXISTS ${s}.idx_audit_log_soft_delete`)
	await pool.query(`DROP INDEX IF EXISTS ${s}.idx_audit_log_hard_delete`)

	await pool.query(
		`ALTER TABLE ${auditTable} DROP COLUMN IF EXISTS archived_at`,
	)
	await pool.query(`ALTER TABLE ${auditTable} DROP COLUMN IF EXISTS s3_path`)
	await pool.query(
		`ALTER TABLE ${auditTable} DROP COLUMN IF EXISTS soft_deleted_at`,
	)
	await pool.query(`ALTER TABLE ${auditTable} DROP COLUMN IF EXISTS claim_id`)
	await pool.query(`ALTER TABLE ${auditTable} DROP COLUMN IF EXISTS claimed_at`)
}
