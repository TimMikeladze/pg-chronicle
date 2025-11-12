import { SQL } from 'bun'

/**
 * IMPORTANT: Tests must run serially, not in parallel.
 *
 * This module uses a singleton testSql connection that is shared across tests.
 * Running tests in parallel would cause race conditions and connection conflicts.
 *
 * Bun's test runner defaults to serial execution, which is safe for this module.
 * Do not configure parallel test execution without refactoring this module to use
 * connection pooling or per-test connections.
 */

const TEST_DB_NAME = 'pg_audit_test'
const BASE_URL =
	process.env.PG_AUDIT_TEST_URL || 'postgres://postgres:postgres@localhost:5432'

let testSql: SQL | null = null

export async function createTestDatabase(): Promise<void> {
	// Connect to postgres database to create test db
	const adminSql = new SQL(`${BASE_URL}/postgres`)

	try {
		// Terminate active connections before dropping
		try {
			await adminSql.unsafe(`
				SELECT pg_terminate_backend(pid)
				FROM pg_stat_activity
				WHERE datname = '${TEST_DB_NAME}'
				AND pid <> pg_backend_pid()
			`)
		} catch (error) {
			// Ignore errors if database doesn't exist or no connections to terminate
			console.warn(
				`Warning: Failed to terminate connections to ${TEST_DB_NAME}:`,
				error instanceof Error ? error.message : String(error),
			)
		}

		// Drop if exists
		try {
			await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`)
		} catch (error) {
			throw new Error(
				`Failed to drop test database ${TEST_DB_NAME}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		// Create fresh
		try {
			await adminSql.unsafe(`CREATE DATABASE ${TEST_DB_NAME}`)
		} catch (error) {
			throw new Error(
				`Failed to create test database ${TEST_DB_NAME}: ${error instanceof Error ? error.message : String(error)}`,
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
				WHERE datname = '${TEST_DB_NAME}'
				AND pid <> pg_backend_pid()
			`)
		} catch (error) {
			// Ignore errors if database doesn't exist or no connections to terminate
			console.warn(
				`Warning: Failed to terminate connections to ${TEST_DB_NAME}:`,
				error instanceof Error ? error.message : String(error),
			)
		}

		try {
			await adminSql.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`)
		} catch (error) {
			throw new Error(
				`Failed to drop test database ${TEST_DB_NAME}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	} finally {
		await adminSql.close()
	}
}

export async function getTestConnection(): Promise<SQL> {
	if (!testSql) {
		try {
			testSql = new SQL(`${BASE_URL}/${TEST_DB_NAME}`)
		} catch (error) {
			// Clean up on failure
			testSql = null
			throw new Error(
				`Failed to connect to test database ${TEST_DB_NAME}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
	return testSql
}

export async function closeTestConnection(): Promise<void> {
	if (testSql) {
		await testSql.close()
		testSql = null
	}
}

export async function cleanDatabase(): Promise<void> {
	const sql = await getTestConnection()

	// Drop all tables in public schema
	const tables = await sql`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
  `

	for (const { tablename } of tables) {
		await sql.unsafe(`DROP TABLE IF EXISTS ${tablename} CASCADE`)
	}
}
