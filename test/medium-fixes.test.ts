import { beforeEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PgHistory } from '../src'
import { writeParquet } from '../src/parquet'
import { setupArchiverSchema } from '../src/schema'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

async function createUsersTable(): Promise<void> {
	const pool = await getTestConnection()
	await pool.query(`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT
    )
  `)
}

describe('M2: TRUNCATE is audited', () => {
	beforeEach(createUsersTable)

	test('records a TRUNCATE marker entry when the table is truncated', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		await pool.query(
			`INSERT INTO users (id, name, email) VALUES (1, 'A', 'a@x.com')`,
		)
		await pool.query(`TRUNCATE users`)

		const res = await pool.query(
			`SELECT table_name, record_id, operation FROM audit_log WHERE operation = 'TRUNCATE'`,
		)
		expect(res.rows.length).toBe(1)
		expect(res.rows[0].table_name).toBe('users')
	})
})

describe('M1: append-only guard', () => {
	beforeEach(createUsersTable)

	test('blocks UPDATE/DELETE on audit_log but allows the maintenance context', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'], appendOnly: true })
		await audit.setup()

		// Normal audit INSERT still works (guard is UPDATE/DELETE only).
		await pool.query(
			`INSERT INTO users (id, name, email) VALUES (1, 'A', 'a@x.com')`,
		)

		await expect(
			pool.query(
				`UPDATE audit_log SET record_id = 'x' WHERE table_name = 'users'`,
			),
		).rejects.toThrow(/append-only/)
		await expect(
			pool.query(`DELETE FROM audit_log WHERE table_name = 'users'`),
		).rejects.toThrow(/append-only/)

		// The pghistory maintenance context (as the archiver uses) is allowed.
		const client = await pool.connect()
		try {
			await client.query('BEGIN')
			await client.query(`SET LOCAL pg_history.maintenance = 'on'`)
			const upd = await client.query(
				`UPDATE audit_log SET record_id = record_id WHERE table_name = 'users'`,
			)
			await client.query('COMMIT')
			expect(upd.rowCount).toBeGreaterThan(0)
		} finally {
			client.release()
		}

		await audit.teardown()
	})
})

describe('M4: checksum is persisted for pre-purge verification', () => {
	beforeEach(createUsersTable)

	test('audit_archive_metadata has a checksum_sha256 column', async () => {
		const pool = await getTestConnection()
		// audit_log must exist before the archiver schema can extend it.
		await new PgHistory({ pool, tables: ['users'] }).setup()
		await setupArchiverSchema(pool)
		const res = await pool.query(
			`SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'audit_archive_metadata'
         AND column_name = 'checksum_sha256'`,
		)
		expect(res.rows.length).toBe(1)
	})
})

describe('M5: jsonb integer precision survives archival', () => {
	test('writeParquet stores JSON text verbatim (no double-encode, no precision loss)', async () => {
		// The archiver selects old_data/new_data as ::text, so writeParquet receives
		// exact JSON strings — including integers beyond 2^53. They must be stored
		// byte-for-byte, not re-parsed/re-stringified.
		const bigIntJson = '{"balance":9007199254740993}'
		const tmpFile = join(tmpdir(), `pghistory-m5-${process.pid}.parquet`)
		try {
			await writeParquet(
				[
					{
						id: '1',
						table_name: 'accounts',
						record_id: '1',
						operation: 'UPDATE',
						changed_at: new Date('2026-01-01T00:00:00Z'),
						old_data: bigIntJson,
						new_data: null,
					},
				],
				tmpFile,
			)

			const { asyncBufferFromFile, parquetReadObjects } = await import(
				'hyparquet'
			)
			const file = await asyncBufferFromFile(tmpFile)
			const raw = await parquetReadObjects({ file })
			// The raw stored column is the exact JSON text with the full-precision int.
			expect(raw[0]?.old_data).toBe(bigIntJson)
		} finally {
			await rm(tmpFile).catch(() => {})
		}
	})
})
