/**
 * Revert's failure paths.
 *
 * These are the branches that decide whether a revert is refused or lets a
 * half-understood write through, and they were the least-covered logic in the
 * library. Every case here is a refusal that has to happen: reverting is the
 * one destructive thing the API can do, so "we could not work out what this
 * entry means" must never resolve to a write.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import { PgHistory } from '../src'
import { RevertError } from '../src/errors'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

/** The audit id of the newest entry for a record. */
async function latestEntryId(
	history: PgHistory,
	table: string,
	recordId: string,
): Promise<string> {
	const result = await history.getHistory(table, recordId)
	const id = result.data[0]?.id
	if (!id) throw new Error('expected at least one audit entry')
	return id
}

describe('revert refuses entries it cannot faithfully apply', () => {
	beforeEach(async () => {
		const pool = await getTestConnection()
		await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      )
    `)
	})

	test('a column that no longer exists on the table', async () => {
		const pool = await getTestConnection()
		const history = new PgHistory({ pool, tables: ['users'] })
		await history.setup()

		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)
		await pool.query(`UPDATE users SET name = 'Alice Smith' WHERE id = 1`)
		const entryId = await latestEntryId(history, 'users', '1')

		// Schema drift: the audited payload mentions a column the live table has
		// since lost. Writing the rest anyway would silently drop data the
		// operator believes they are restoring.
		await pool.query(`ALTER TABLE users DROP COLUMN email`)
		history.invalidatePrimaryKeyCache()

		await expect(history.revert('users', '1', entryId)).rejects.toThrow(
			/columns not in table/i,
		)
	})

	test('a DELETE whose row predates a NOT NULL column', async () => {
		const pool = await getTestConnection()
		const history = new PgHistory({ pool, tables: ['users'] })
		await history.setup()

		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)
		await pool.query(`DELETE FROM users WHERE id = 1`)
		const entryId = await latestEntryId(history, 'users', '1')

		// Re-inserting would violate the new constraint. The PG error alone
		// ("null value in column ... violates not-null") does not tell the
		// operator that the schema moved under the entry.
		await pool.query(
			`ALTER TABLE users ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'x'`,
		)
		await pool.query(`ALTER TABLE users ALTER COLUMN tenant_id DROP DEFAULT`)

		await expect(history.revert('users', '1', entryId)).rejects.toThrow(
			/required columns not present/i,
		)
	})

	test('a DELETE whose key has since been taken', async () => {
		const pool = await getTestConnection()
		const history = new PgHistory({ pool, tables: ['users'] })
		await history.setup()

		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)
		await pool.query(`DELETE FROM users WHERE id = 1`)
		const entryId = await latestEntryId(history, 'users', '1')

		// Someone recreated the row. Re-inserting collides; the raw 23505 is
		// translated into the actual situation.
		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Someone else')`)

		await expect(history.revert('users', '1', entryId)).rejects.toThrow(
			/already exists/i,
		)
	})

	test('an INSERT whose row is already gone', async () => {
		const pool = await getTestConnection()
		const history = new PgHistory({ pool, tables: ['users'] })
		await history.setup()

		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)
		const insertEntry = (await history.getHistory('users', '1')).data.find(
			(e) => e.operation === 'INSERT',
		)
		expect(insertEntry).toBeDefined()

		await pool.query(`DELETE FROM users WHERE id = 1`)

		// Reverting an INSERT means DELETE; with nothing to delete the revert did
		// not happen and must not report success.
		await expect(
			history.revert('users', '1', insertEntry?.id ?? ''),
		).rejects.toThrow(/row not found/i)
	})

	test('an entry belonging to a different record', async () => {
		const pool = await getTestConnection()
		const history = new PgHistory({ pool, tables: ['users'] })
		await history.setup()

		await pool.query(
			`INSERT INTO users (id, name) VALUES (1, 'Alice'), (2, 'Bob')`,
		)
		await pool.query(`UPDATE users SET name = 'Bob Smith' WHERE id = 2`)
		const bobEntry = await latestEntryId(history, 'users', '2')

		// The lookup is scoped by (id, table, record) — an entry id alone must not
		// let a caller write Bob's values onto Alice.
		await expect(history.revert('users', '1', bobEntry)).rejects.toThrow(
			/not found/i,
		)
	})

	test('a table with no primary key', async () => {
		const pool = await getTestConnection()
		await pool.query(`CREATE TABLE events (name TEXT, payload TEXT)`)
		const history = new PgHistory({ pool, tables: ['events'] })
		await history.setup()

		await pool.query(`INSERT INTO events (name, payload) VALUES ('a', 'b')`)
		const entries = await history.search({ tables: ['events'] })
		const entry = entries.data[0]
		expect(entry).toBeDefined()

		// Without a PK there is no WHERE clause that identifies one row, so a
		// revert could hit every row in the table.
		await expect(
			history.revert('events', entry?.recordId ?? '', entry?.id ?? ''),
		).rejects.toThrow(/no primary key/i)
	})

	test('an UPDATE carrying nothing but its primary key', async () => {
		const pool = await getTestConnection()
		await pool.query(`CREATE TABLE flags (id SERIAL PRIMARY KEY, on_ BOOLEAN)`)
		const history = new PgHistory({
			pool,
			tables: ['flags'],
			// Every non-PK column excluded: the entry records that something
			// changed but carries no restorable value.
			excludeColumns: { flags: ['on_'] },
		})
		await history.setup()

		await pool.query(`INSERT INTO flags (id, on_) VALUES (1, true)`)
		await pool.query(`UPDATE flags SET on_ = false WHERE id = 1`)
		const entryId = await latestEntryId(history, 'flags', '1')

		await expect(history.revert('flags', '1', entryId)).rejects.toThrow(
			/no non-primary-key columns/i,
		)
	})

	test('the refusals are RevertError, so the API maps them to 422', async () => {
		const pool = await getTestConnection()
		const history = new PgHistory({ pool, tables: ['users'] })
		await history.setup()

		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)
		const insertEntry = (await history.getHistory('users', '1')).data.find(
			(e) => e.operation === 'INSERT',
		)
		await pool.query(`DELETE FROM users WHERE id = 1`)

		const error = await history
			.revert('users', '1', insertEntry?.id ?? '')
			.then(() => null)
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(RevertError)
	})
})
