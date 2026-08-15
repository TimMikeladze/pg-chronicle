/**
 * `POST /api/history/revert` over HTTP.
 *
 * This is the only endpoint that writes to a user's tables, and it had no
 * coverage at the HTTP layer at all — the revert logic was tested directly,
 * the route that exposes it was not. What matters here is that each way a
 * revert can be refused reaches the client as a distinct, actionable status
 * rather than a blanket 500.
 */
import { beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { PgChronicle } from '../src'
import { createServer } from '../src/server'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

async function historyServer(
	pool: Pool,
	extra: Partial<Parameters<typeof createServer>[0]> = {},
) {
	return createServer({
		pool,
		enableHistory: true,
		historyConfig: { tables: ['users'] },
		allowUnauthenticated: true,
		serverless: true,
		...extra,
	})
}

function post(
	app: Awaited<ReturnType<typeof createServer>>['app'],
	body: unknown,
) {
	return app.request('/api/history/revert', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: typeof body === 'string' ? body : JSON.stringify(body),
	})
}

describe('POST /api/history/revert', () => {
	let pool: Pool
	let history: PgChronicle

	beforeEach(async () => {
		pool = await getTestConnection()
		await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      )
    `)
		history = new PgChronicle({ pool, tables: ['users'] })
		await history.setup()
	})

	/** Insert a user, rename them, and return the id of the UPDATE entry. */
	async function seedUpdate(): Promise<string> {
		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)
		await pool.query(`UPDATE users SET name = 'Alice Smith' WHERE id = 1`)
		const entries = await history.getHistory('users', '1')
		const update = entries.data.find((e) => e.operation === 'UPDATE')
		if (!update) throw new Error('expected an UPDATE entry')
		return update.id
	}

	test('reverts the row and reports success', async () => {
		const entryId = await seedUpdate()
		const { app } = await historyServer(pool)

		const res = await post(app, {
			table: 'users',
			recordId: '1',
			auditEntryId: entryId,
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ success: true })

		// The point of the endpoint: the table actually moved back.
		const row = await pool.query(`SELECT name FROM users WHERE id = 1`)
		expect(row.rows[0].name).toBe('Alice')
	})

	test('the revert is itself audited by default', async () => {
		const entryId = await seedUpdate()
		const { app } = await historyServer(pool)
		await post(app, { table: 'users', recordId: '1', auditEntryId: entryId })

		// Repudiation defence: undoing a change must not erase the fact that
		// someone undid it.
		const entries = await history.getHistory('users', '1')
		const updates = entries.data.filter((e) => e.operation === 'UPDATE')
		expect(updates.length).toBe(2)
	})

	test('malformed JSON is a 400, not a 500', async () => {
		const { app } = await historyServer(pool)
		const res = await post(app, '{not json')
		expect(res.status).toBe(400)
		expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
	})

	test('a missing field is a 400', async () => {
		const { app } = await historyServer(pool)
		const res = await post(app, { table: 'users', recordId: '1' })
		expect(res.status).toBe(400)
		expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
	})

	test('a non-numeric audit id is rejected at the boundary', async () => {
		const { app } = await historyServer(pool)
		// Would otherwise reach `$1::bigint` and surface as a 500.
		const res = await post(app, {
			table: 'users',
			recordId: '1',
			auditEntryId: 'not-a-number',
		})
		expect(res.status).toBe(400)
	})

	test('a table outside the allowlist is a 400, not a 403 or a 500', async () => {
		const { app } = await historyServer(pool)
		const res = await post(app, {
			table: 'secrets',
			recordId: '1',
			auditEntryId: '1',
		})
		expect(res.status).toBe(400)
	})

	test('an unknown audit entry is a 404', async () => {
		await seedUpdate()
		const { app } = await historyServer(pool)
		const res = await post(app, {
			table: 'users',
			recordId: '1',
			auditEntryId: '999999',
		})
		expect(res.status).toBe(404)
		expect((await res.json()).error.code).toBe('NOT_FOUND')
	})

	test('a revert that cannot be applied is a 422', async () => {
		// Reverting an INSERT deletes the row; with the row already gone the
		// revert is well-formed but inapplicable — a client distinction worth
		// keeping separate from "bad request" and from "server broke".
		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)
		const insert = (await history.getHistory('users', '1')).data.find(
			(e) => e.operation === 'INSERT',
		)
		await pool.query(`DELETE FROM users WHERE id = 1`)

		const { app } = await historyServer(pool)
		const res = await post(app, {
			table: 'users',
			recordId: '1',
			auditEntryId: insert?.id,
		})
		expect(res.status).toBe(422)
		expect((await res.json()).error.code).toBe('REVERT_ERROR')
	})

	test('the authorize hook can refuse a revert it would otherwise allow', async () => {
		const entryId = await seedUpdate()
		const { app } = await historyServer(pool, {
			// Reads stay open, writes do not — the shape of a real read-only role.
			authorize: ({ action }) => action !== 'revert',
		})

		const res = await post(app, {
			table: 'users',
			recordId: '1',
			auditEntryId: entryId,
		})
		expect(res.status).toBe(403)

		// Refused means unchanged, not "refused after writing".
		const row = await pool.query(`SELECT name FROM users WHERE id = 1`)
		expect(row.rows[0].name).toBe('Alice Smith')
	})

	test('a throwing authorize hook denies rather than erroring open', async () => {
		const entryId = await seedUpdate()
		const { app } = await historyServer(pool, {
			authorize: () => {
				throw new Error('policy service unreachable')
			},
		})

		const res = await post(app, {
			table: 'users',
			recordId: '1',
			auditEntryId: entryId,
		})
		expect(res.status).toBe(403)
	})
})

describe('dispose()', () => {
	test('is idempotent and safe to call without any archival running', async () => {
		const pool = await getTestConnection()
		const { dispose } = await createServer({ pool, allowUnauthenticated: true })

		// Shutdown paths fire SIGTERM and SIGINT, and a caller may also dispose
		// explicitly — the second call must not throw.
		await dispose(100)
		await dispose(100)
	})
})
