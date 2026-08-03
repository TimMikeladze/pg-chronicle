import { beforeEach, describe, expect, test } from 'bun:test'
import { createServer, PgHistory } from '../src'
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

describe('C2: fail closed on missing auth', () => {
	beforeEach(createUsersTable)

	test('createServer throws when history is enabled without a JWT secret', async () => {
		const pool = await getTestConnection()
		const original = process.env.PGHISTORY_JWT_SECRET
		delete process.env.PGHISTORY_JWT_SECRET
		try {
			await expect(
				createServer({
					pool,
					enableHistory: true,
					historyConfig: { tables: ['users'] },
				}),
			).rejects.toThrow(/Refusing to start/)
		} finally {
			if (original !== undefined) process.env.PGHISTORY_JWT_SECRET = original
		}
	})

	test('createServer starts when allowUnauthenticated is explicitly set', async () => {
		const pool = await getTestConnection()
		const original = process.env.PGHISTORY_JWT_SECRET
		delete process.env.PGHISTORY_JWT_SECRET
		try {
			const { app } = await createServer({
				pool,
				enableHistory: true,
				allowUnauthenticated: true,
				historyConfig: { tables: ['users'] },
			})
			expect(app).toBeDefined()
		} finally {
			if (original !== undefined) process.env.PGHISTORY_JWT_SECRET = original
		}
	})
})

describe('C3: audit trail captures actor metadata', () => {
	beforeEach(createUsersTable)

	test('records db_user on every change', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		await pool.query(
			`INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'a@example.com')`,
		)

		const { data } = await audit.getHistory('users', '1')
		expect(data.length).toBe(1)
		// current_user is whatever role the test connection uses — just assert it
		// was captured (non-null, non-empty).
		expect(typeof data[0]?.dbUser).toBe('string')
		expect(data[0]?.dbUser?.length).toBeGreaterThan(0)
	})

	test('records app_actor from the pg_history.actor session setting', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		// SET LOCAL + the DML must run on the same connection/transaction.
		const client = await pool.connect()
		try {
			await client.query('BEGIN')
			await client.query(`SET LOCAL pg_history.actor = 'user-42'`)
			await client.query(
				`INSERT INTO users (id, name, email) VALUES (7, 'Bob', 'b@example.com')`,
			)
			await client.query('COMMIT')
		} finally {
			client.release()
		}

		const { data } = await audit.getHistory('users', '7')
		expect(data[0]?.appActor).toBe('user-42')
	})

	test('app_actor is null when the session setting is unset', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		await pool.query(
			`INSERT INTO users (id, name, email) VALUES (9, 'Cy', 'c@example.com')`,
		)

		const { data } = await audit.getHistory('users', '9')
		expect(data[0]?.appActor).toBeNull()
	})
})

describe('H1: authorization hook', () => {
	beforeEach(createUsersTable)

	async function seed(): Promise<void> {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()
		await pool.query(
			`INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'a@example.com')`,
		)
	}

	test('denies read with 403 when authorize returns false', async () => {
		await seed()
		const pool = await getTestConnection()
		const { app } = await createServer({
			pool,
			enableHistory: true,
			allowUnauthenticated: true,
			historyConfig: { tables: ['users'] },
			authorize: () => false,
		})
		const res = await app.request('/api/history/users/1')
		expect(res.status).toBe(403)
	})

	test('allows read when authorize returns true', async () => {
		await seed()
		const pool = await getTestConnection()
		const { app } = await createServer({
			pool,
			enableHistory: true,
			allowUnauthenticated: true,
			historyConfig: { tables: ['users'] },
			authorize: (ctx) => ctx.table === 'users' && ctx.action === 'read',
		})
		const res = await app.request('/api/history/users/1')
		expect(res.status).toBe(200)
	})
})
