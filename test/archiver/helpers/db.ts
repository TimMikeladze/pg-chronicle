import type { Pool } from 'pg'
import pkg from 'pg'

const { Pool: PgPool } = pkg

const TEST_DB = 'pg_audit_archiver_test'
const BASE_URL = 'postgres://postgres:postgres@localhost:5432'

export async function createTestDatabase(): Promise<void> {
	// Connect to postgres database to create test db
	const adminPool = new PgPool({ connectionString: `${BASE_URL}/postgres` })

	try {
		// Terminate active connections before dropping
		try {
			await adminPool.query(
				`
				SELECT pg_terminate_backend(pid)
				FROM pg_stat_activity
				WHERE datname = $1
				AND pid <> pg_backend_pid()
			`,
				[TEST_DB],
			)
		} catch (_error) {
			// Ignore errors if database doesn't exist or no connections to terminate
		}

		// Drop if exists
		try {
			await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`)
		} catch (error) {
			throw new Error(
				`Failed to drop test database ${TEST_DB}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		// Create fresh
		try {
			await adminPool.query(`CREATE DATABASE ${TEST_DB}`)
		} catch (error) {
			throw new Error(
				`Failed to create test database ${TEST_DB}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	} finally {
		await adminPool.end()
	}
}

export async function dropTestDatabase(): Promise<void> {
	const adminPool = new PgPool({ connectionString: `${BASE_URL}/postgres` })

	try {
		// Terminate active connections before dropping
		try {
			await adminPool.query(
				`
				SELECT pg_terminate_backend(pid)
				FROM pg_stat_activity
				WHERE datname = $1
				AND pid <> pg_backend_pid()
			`,
				[TEST_DB],
			)
		} catch (_error) {
			// Ignore errors if database doesn't exist or no connections to terminate
		}

		try {
			await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB}`)
		} catch (error) {
			throw new Error(
				`Failed to drop test database ${TEST_DB}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	} finally {
		await adminPool.end()
	}
}

export async function getTestConnection(): Promise<Pool> {
	return new PgPool({ connectionString: `${BASE_URL}/${TEST_DB}` })
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
      INSERT INTO audit_log (table_name, record_id, operation, changed_at, new_data, changed_by)
      VALUES ($1, $2, $3, $4, $5, $6)
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
      INSERT INTO audit_log (table_name, record_id, operation, changed_at, new_data, changed_by)
      VALUES ($1, $2, $3, $4, $5, $6)
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
