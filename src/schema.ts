import type { SQL } from 'bun'

export async function setupArchiverSchema(sql: SQL): Promise<void> {
	// Add archived_at column to audit_log
	await sql`
    ALTER TABLE audit_log
      ADD COLUMN IF NOT EXISTS archived_at TIMESTAMP
  `

	// Add soft_deleted_at column
	await sql`
    ALTER TABLE audit_log
      ADD COLUMN IF NOT EXISTS soft_deleted_at TIMESTAMPTZ
  `

	// Create index on archived_at
	await sql`
    CREATE INDEX IF NOT EXISTS idx_audit_log_archived
      ON audit_log(archived_at)
      WHERE archived_at IS NOT NULL
  `

	// Create index on soft_deleted_at
	await sql`
    CREATE INDEX IF NOT EXISTS idx_audit_log_soft_deleted
      ON audit_log(soft_deleted_at)
      WHERE soft_deleted_at IS NOT NULL
  `

	// Create metadata tracking table
	await sql`
    CREATE TABLE IF NOT EXISTS audit_archive_metadata (
      id SERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      archive_date DATE NOT NULL,
      s3_path TEXT NOT NULL,
      record_count INTEGER NOT NULL,
      file_size BIGINT NOT NULL,
      archived_at TIMESTAMP NOT NULL DEFAULT NOW(),
      status TEXT NOT NULL CHECK (status IN ('completed', 'failed', 'in_progress')),
      error_message TEXT,
      UNIQUE(table_name, archive_date, s3_path)
    )
  `

	// Create indexes on metadata table
	await sql`
    CREATE INDEX IF NOT EXISTS idx_archive_metadata_table_date
      ON audit_archive_metadata(table_name, archive_date)
  `

	await sql`
    CREATE INDEX IF NOT EXISTS idx_archive_metadata_status
      ON audit_archive_metadata(status)
  `
}

export async function teardownArchiverSchema(sql: SQL): Promise<void> {
	// Drop metadata table
	await sql`DROP TABLE IF EXISTS audit_archive_metadata CASCADE`

	// Remove archived_at column (optional - might want to keep)
	await sql`ALTER TABLE audit_log DROP COLUMN IF EXISTS archived_at CASCADE`

	// Remove soft_deleted_at column
	await sql`ALTER TABLE audit_log DROP COLUMN IF EXISTS soft_deleted_at CASCADE`
}
