import type { Pool } from 'pg'
import pkg from 'pg'
import {
	dropDatabase,
	recreateDatabase,
	testDatabaseUrl,
} from '../../helpers/database'

const { Pool: PgPool } = pkg

const TEST_DB = 'pg_audit_archiver_test'

export async function createTestDatabase(): Promise<void> {
	await recreateDatabase(TEST_DB)
}

export async function dropTestDatabase(): Promise<void> {
	await dropDatabase(TEST_DB)
}

export async function getTestConnection(): Promise<Pool> {
	return new PgPool({ connectionString: testDatabaseUrl(TEST_DB) })
}

export async function setupTestData(pool: Pool): Promise<void> {
	// Create audit_log table matching the PRODUCTION schema shape created by
	// PgHistory.setup() — id is BIGSERIAL so parquet INT64 storage works.
	// Note: real PgHistory uses partitioning; tests skip that for simplicity.
	await pool.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id BIGSERIAL PRIMARY KEY,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL,
      old_data JSONB,
      new_data JSONB,
      db_user TEXT,
      app_actor TEXT,
      client_addr INET,
      changed_by TEXT,
      metadata JSONB
    )
  `)

	// Insert test records (let BIGSERIAL assign ids)
	const oldDate = new Date('2024-01-15')
	const recentDate = new Date()

	for (let i = 0; i < 100; i++) {
		await pool.query(
			`
      INSERT INTO audit_log (table_name, record_id, operation, changed_at, new_data, changed_by,
                             db_user, app_actor, client_addr)
      VALUES ($1, $2, $3, $4, $5, $6, 'app_role', 'user-42', '203.0.113.7')
    `,
			[
				'users',
				`user-${i}`,
				'INSERT',
				oldDate,
				JSON.stringify({ name: `User ${i}` }),
				'system',
			],
		)
	}

	for (let i = 0; i < 50; i++) {
		await pool.query(
			`
      INSERT INTO audit_log (table_name, record_id, operation, changed_at, new_data, changed_by,
                             db_user, app_actor, client_addr)
      VALUES ($1, $2, $3, $4, $5, $6, 'app_role', 'user-42', '203.0.113.7')
    `,
			[
				'users',
				`user-${i + 100}`,
				'INSERT',
				recentDate,
				JSON.stringify({ name: `User ${i + 100}` }),
				'system',
			],
		)
	}
}

export async function cleanupTestData(pool: Pool): Promise<void> {
	await pool.query(`DROP TABLE IF EXISTS audit_log CASCADE`)
	await pool.query(`DROP TABLE IF EXISTS audit_archive_metadata CASCADE`)
}
