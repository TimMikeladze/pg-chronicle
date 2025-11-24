import type { Pool } from 'pg'
import pkg from 'pg'

const { Pool: PgPool } = pkg

/**
 * IMPORTANT: Tests must run serially, not in parallel.
 *
 * This module uses a singleton testPool connection that is shared across tests.
 * Running tests in parallel would cause race conditions and connection conflicts.
 *
 * Bun's test runner defaults to serial execution, which is safe for this module.
 * Do not configure parallel test execution without refactoring this module to use
 * connection pooling or per-test connections.
 */

const TEST_DB_NAME = 'pg_audit_test'
const BASE_URL =
	process.env.PG_AUDIT_TEST_URL || 'postgres://postgres:postgres@localhost:5432'

let testPool: Pool | null = null

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
				[TEST_DB_NAME],
			)
		} catch (error) {
			// Ignore errors if database doesn't exist or no connections to terminate
			console.warn(
				`Warning: Failed to terminate connections to ${TEST_DB_NAME}:`,
				error instanceof Error ? error.message : String(error),
			)
		}

		// Drop if exists
		try {
			await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`)
		} catch (error) {
			throw new Error(
				`Failed to drop test database ${TEST_DB_NAME}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		// Create fresh
		try {
			await adminPool.query(`CREATE DATABASE ${TEST_DB_NAME}`)
		} catch (error) {
			throw new Error(
				`Failed to create test database ${TEST_DB_NAME}: ${error instanceof Error ? error.message : String(error)}`,
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
				[TEST_DB_NAME],
			)
		} catch (error) {
			// Ignore errors if database doesn't exist or no connections to terminate
			console.warn(
				`Warning: Failed to terminate connections to ${TEST_DB_NAME}:`,
				error instanceof Error ? error.message : String(error),
			)
		}

		try {
			await adminPool.query(`DROP DATABASE IF EXISTS ${TEST_DB_NAME}`)
		} catch (error) {
			throw new Error(
				`Failed to drop test database ${TEST_DB_NAME}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	} finally {
		await adminPool.end()
	}
}

export async function getTestConnection(): Promise<Pool> {
	if (!testPool) {
		try {
			testPool = new PgPool({ connectionString: `${BASE_URL}/${TEST_DB_NAME}` })
		} catch (error) {
			// Clean up on failure
			testPool = null
			throw new Error(
				`Failed to connect to test database ${TEST_DB_NAME}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	}
	return testPool
}

export async function closeTestConnection(): Promise<void> {
	if (testPool) {
		await testPool.end()
		testPool = null
	}
}

export async function cleanDatabase(): Promise<void> {
	const pool = await getTestConnection()

	// Drop all tables in public schema
	const result = await pool.query(
		`
    SELECT tablename FROM pg_tables
    WHERE schemaname = $1
  `,
		['public'],
	)

	for (const { tablename } of result.rows) {
		await pool.query(`DROP TABLE IF EXISTS ${tablename} CASCADE`)
	}
}
