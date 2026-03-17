import type { Pool } from 'pg'

async function getSchemaPrefix(pool: Pool): Promise<string> {
	const result = await pool.query('SELECT current_schema() as schema')
	const schema = result.rows[0]?.schema || 'public'
	return `"${schema}"`
}

export async function setupArchiverSchema(pool: Pool): Promise<void> {
	const s = await getSchemaPrefix(pool)
	const auditTable = `${s}."audit_log"`
	const metadataTable = `${s}."audit_archive_metadata"`
	const statsTable = `${s}."audit_archival_stats"`

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

	// Create composite index for archival queries
	await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_log_archival
      ON ${auditTable}(table_name, changed_at)
      WHERE archived_at IS NULL
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
 * Update archival stats for a table
 * Call this periodically to keep stats fresh without scanning full audit_log
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

	// Get counts in a single query using FILTER
	const result = await pool.query(
		`SELECT
      COUNT(*) FILTER (WHERE archived_at IS NULL AND changed_at < $2) as pending_archive,
      COUNT(*) FILTER (WHERE archived_at IS NOT NULL AND archived_at < $3 AND soft_deleted_at IS NULL AND s3_path IS NOT NULL) as pending_soft_delete,
      COUNT(*) FILTER (WHERE soft_deleted_at IS NOT NULL AND soft_deleted_at < $3) as pending_hard_delete,
      MIN(changed_at) FILTER (WHERE archived_at IS NULL) as oldest_unarchived
    FROM ${auditTable}
    WHERE table_name = $1
      AND (
        (archived_at IS NULL AND changed_at < $2)
        OR (archived_at IS NOT NULL AND archived_at < $3 AND soft_deleted_at IS NULL)
        OR (soft_deleted_at IS NOT NULL AND soft_deleted_at < $3)
      )`,
		[tableName, retentionCutoff, gracePeriodCutoff],
	)

	const stats = result.rows[0]

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
      records_pending_archive = $2,
      records_pending_soft_delete = $3,
      records_pending_hard_delete = $4,
      oldest_unarchived_record = $5,
      last_updated = NOW()`,
		[
			tableName,
			stats.pending_archive || 0,
			stats.pending_soft_delete || 0,
			stats.pending_hard_delete || 0,
			stats.oldest_unarchived || null,
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

	// Remove archived_at column (optional - might want to keep)
	await pool.query(
		`ALTER TABLE ${auditTable} DROP COLUMN IF EXISTS archived_at CASCADE`,
	)

	// Remove s3_path column
	await pool.query(
		`ALTER TABLE ${auditTable} DROP COLUMN IF EXISTS s3_path CASCADE`,
	)

	// Remove soft_deleted_at column
	await pool.query(
		`ALTER TABLE ${auditTable} DROP COLUMN IF EXISTS soft_deleted_at CASCADE`,
	)
}
