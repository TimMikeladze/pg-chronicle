/**
 * Create/drop lifecycle for a throwaway test database.
 *
 * The two suites (library and archiver) each need their own database and their
 * own connection strategy — the library tests share one pool, the archiver
 * tests open and close one per test — but the create/drop dance underneath was
 * duplicated line for line, including the "terminate stragglers first" step
 * that is the only reason DROP DATABASE reliably succeeds.
 */
import pkg from 'pg'

const { Pool: PgPool } = pkg

/**
 * Base URL WITHOUT a database name — the suffix is appended per database.
 * `PG_AUDIT_TEST_URL` points both suites at a different server.
 */
export const TEST_BASE_URL =
	process.env.PG_AUDIT_TEST_URL || 'postgres://postgres:postgres@localhost:5432'

export function testDatabaseUrl(name: string): string {
	return `${TEST_BASE_URL}/${name}`
}

async function withAdminPool<T>(
	fn: (pool: pkg.Pool) => Promise<T>,
): Promise<T> {
	const adminPool = new PgPool({
		connectionString: testDatabaseUrl('postgres'),
	})
	try {
		return await fn(adminPool)
	} finally {
		await adminPool.end()
	}
}

/**
 * Sessions left open by a previous run hold DROP DATABASE off indefinitely, so
 * evict them first. Failure here is not fatal: the database may simply not
 * exist yet.
 */
async function terminateConnections(
	pool: pkg.Pool,
	name: string,
): Promise<void> {
	try {
		await pool.query(
			`SELECT pg_terminate_backend(pid)
			 FROM pg_stat_activity
			 WHERE datname = $1
			   AND pid <> pg_backend_pid()`,
			[name],
		)
	} catch (error) {
		console.warn(
			`Warning: Failed to terminate connections to ${name}:`,
			error instanceof Error ? error.message : String(error),
		)
	}
}

/** Drop and recreate `name`, leaving an empty database. */
export async function recreateDatabase(name: string): Promise<void> {
	await withAdminPool(async (adminPool) => {
		await terminateConnections(adminPool, name)

		try {
			await adminPool.query(`DROP DATABASE IF EXISTS ${name}`)
		} catch (error) {
			throw new Error(
				`Failed to drop test database ${name}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}

		try {
			await adminPool.query(`CREATE DATABASE ${name}`)
		} catch (error) {
			throw new Error(
				`Failed to create test database ${name}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	})
}

/** Drop `name` if it exists. */
export async function dropDatabase(name: string): Promise<void> {
	await withAdminPool(async (adminPool) => {
		await terminateConnections(adminPool, name)
		try {
			await adminPool.query(`DROP DATABASE IF EXISTS ${name}`)
		} catch (error) {
			throw new Error(
				`Failed to drop test database ${name}: ${error instanceof Error ? error.message : String(error)}`,
			)
		}
	})
}
