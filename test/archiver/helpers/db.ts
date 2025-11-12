import { SQL } from 'bun'

const TEST_DB = 'pg_audit_archiver_test'
const BASE_URL = 'postgres://postgres:postgres@localhost:5432'

export async function createTestDatabase(): Promise<void> {
	// Connect to postgres database to create test db
	const adminSql = new SQL(`${BASE_URL}/postgres`)

	try {
		// Terminate active connections before dropping
		try {
			await adminSql.unsafe(`
				SELECT pg_terminate_backend(pid)
				FROM pg_stat_activity
				WHERE datname = '${TEST_DB}'
				AND pid <> pg_backend_pid()
			`)
		} catch (_error) {
			// Ignore errors if database doesn't exist or no connections to terminate
		}

		// Drop if exists
		try {
			await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`)
		} catch (error) {
			throw new Error(
				`Failed to drop test database ${TEST_DB}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		// Create fresh
		try {
			await adminSql.unsafe(`CREATE DATABASE ${TEST_DB}`)
		} catch (error) {
			throw new Error(
				`Failed to create test database ${TEST_DB}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	} finally {
		await adminSql.close()
	}
}

export async function dropTestDatabase(): Promise<void> {
	const adminSql = new SQL(`${BASE_URL}/postgres`)

	try {
		// Terminate active connections before dropping
		try {
			await adminSql.unsafe(`
				SELECT pg_terminate_backend(pid)
				FROM pg_stat_activity
				WHERE datname = '${TEST_DB}'
				AND pid <> pg_backend_pid()
			`)
		} catch (_error) {
			// Ignore errors if database doesn't exist or no connections to terminate
		}

		try {
			await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB}`)
		} catch (error) {
			throw new Error(
				`Failed to drop test database ${TEST_DB}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	} finally {
		await adminSql.close()
	}
}

export async function getTestConnection(): Promise<SQL> {
	return new SQL(`${BASE_URL}/${TEST_DB}`)
}

export async function setupTestData(sql: SQL): Promise<void> {
	// Create audit_log table for testing
	await sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY,
      table_name TEXT NOT NULL,
      record_id TEXT NOT NULL,
      operation TEXT NOT NULL,
      changed_at TIMESTAMP NOT NULL,
      old_data JSONB,
      new_data JSONB,
      changed_by TEXT,
      metadata JSONB
    )
  `

	// Insert test records
	const oldDate = new Date('2024-01-15')
	const recentDate = new Date()

	for (let i = 0; i < 100; i++) {
		await sql`
      INSERT INTO audit_log (id, table_name, record_id, operation, changed_at, new_data, changed_by)
      VALUES (
        ${`old-${i}`},
        'users',
        ${`user-${i}`},
        'INSERT',
        ${oldDate},
        ${{ name: `User ${i}` }},
        'system'
      )
    `
	}

	for (let i = 0; i < 50; i++) {
		await sql`
      INSERT INTO audit_log (id, table_name, record_id, operation, changed_at, new_data, changed_by)
      VALUES (
        ${`recent-${i}`},
        'users',
        ${`user-${i + 100}`},
        'INSERT',
        ${recentDate},
        ${{ name: `User ${i + 100}` }},
        'system'
      )
    `
	}
}

export async function cleanupTestData(sql: SQL): Promise<void> {
	await sql`DROP TABLE IF EXISTS audit_log CASCADE`
	await sql`DROP TABLE IF EXISTS audit_archive_metadata CASCADE`
}
