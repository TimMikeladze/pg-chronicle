import type { Pool } from 'pg'
import pkg from 'pg'
import { dropDatabase, recreateDatabase, testDatabaseUrl } from './database'

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

let testPool: Pool | null = null

export async function createTestDatabase(): Promise<void> {
	await recreateDatabase(TEST_DB_NAME)
}

export async function dropTestDatabase(): Promise<void> {
	await dropDatabase(TEST_DB_NAME)
}

export async function getTestConnection(): Promise<Pool> {
	if (!testPool) {
		try {
			testPool = new PgPool({
				connectionString: testDatabaseUrl(TEST_DB_NAME),
			})
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
