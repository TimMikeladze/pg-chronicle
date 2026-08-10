/**
 * Regression tests for gaps found in the 2026-08 audit.
 *
 * Each block names the defect it pins down, because every one of these passed
 * a green suite before: the combination that broke was simply never exercised.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { sign } from 'hono/jwt'
import type { Pool } from 'pg'
import { PgHistory } from '../src/PgHistory'
import { createServer } from '../src/server'
import { parseSearchBody } from '../src/validation'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

const ARCHIVER_CONFIG = {
	s3: { bucket: 'test-bucket' },
	retention: { default: 90 },
	gracePeriod: 7,
	batchSize: 100,
}

/**
 * The archiver's schema setup extends `audit_log`, so it has to exist before a
 * server with `enableArchiver` can start. Running PgHistory's own setup is the
 * realistic way to get there.
 */
async function seedAuditLog(pool: Pool): Promise<void> {
	await pool.query(
		`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)`,
	)
	const history = new PgHistory({ pool, tables: ['users'] })
	await history.setup()
}

/** Restore env the tests mutate, whatever the outcome. */
function withEnv(vars: Record<string, string | undefined>): () => void {
	const saved: Record<string, string | undefined> = {}
	for (const [key, value] of Object.entries(vars)) {
		saved[key] = process.env[key]
		if (value === undefined) delete process.env[key]
		else process.env[key] = value
	}
	return () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
}

describe('POST /api/archive accepts either credential', () => {
	let restoreEnv: (() => void) | undefined

	afterEach(() => {
		restoreEnv?.()
		restoreEnv = undefined
	})

	/**
	 * The deadlock: the '/api/*' JWT middleware rejected anything that was not a
	 * token, while the handler demanded the literal cron secret. A request has
	 * one Authorization header, so with both secrets set the route could not be
	 * called at all — by anyone.
	 */
	test('a scheduler can call it with the cron secret while JWT auth is on', async () => {
		restoreEnv = withEnv({ PG_HISTORY_JWT_SECRET: 'jwt-secret-value' })
		const pool = await getTestConnection()
		await seedAuditLog(pool)
		const { app } = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: ARCHIVER_CONFIG,
			archiveCronSecret: 'cron-secret-value',
			serverless: true,
		})

		const res = await app.request('/api/archive', {
			method: 'POST',
			headers: { Authorization: 'Bearer cron-secret-value' },
		})
		// May fail downstream for lack of a real bucket, but must not be rejected.
		expect(res.status).not.toBe(401)
	})

	test('the dashboard can call it with a JWT while a cron secret is set', async () => {
		restoreEnv = withEnv({ PG_HISTORY_JWT_SECRET: 'jwt-secret-value' })
		const pool = await getTestConnection()
		await seedAuditLog(pool)
		const { app } = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: ARCHIVER_CONFIG,
			archiveCronSecret: 'cron-secret-value',
			serverless: true,
		})

		const token = await sign({ sub: 'dashboard' }, 'jwt-secret-value')
		const res = await app.request('/api/archive', {
			method: 'POST',
			headers: { Authorization: `Bearer ${token}` },
		})
		expect(res.status).not.toBe(401)
	})

	test('a credential that is neither is still rejected', async () => {
		restoreEnv = withEnv({ PG_HISTORY_JWT_SECRET: 'jwt-secret-value' })
		const pool = await getTestConnection()
		await seedAuditLog(pool)
		const { app } = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: ARCHIVER_CONFIG,
			archiveCronSecret: 'cron-secret-value',
			serverless: true,
		})

		const res = await app.request('/api/archive', {
			method: 'POST',
			headers: { Authorization: 'Bearer neither-of-them' },
		})
		expect(res.status).toBe(401)
	})

	test('the cron secret does not open non-operational endpoints', async () => {
		restoreEnv = withEnv({ PG_HISTORY_JWT_SECRET: 'jwt-secret-value' })
		const pool = await getTestConnection()
		await seedAuditLog(pool)
		const { app } = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] },
			enableArchiver: true,
			archiverConfig: ARCHIVER_CONFIG,
			archiveCronSecret: 'cron-secret-value',
			serverless: true,
		})

		const res = await app.request('/api/history/search', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer cron-secret-value',
				'content-type': 'application/json',
			},
			body: JSON.stringify({ tables: ['users'] }),
		})
		expect(res.status).toBe(401)
	})
})

/**
 * The registration decisions are the fail-closed guarantees: an endpoint that
 * leaks table names and row volumes must not exist at all when nothing can
 * authenticate it. Until now they were asserted by grepping server.ts for
 * strings, which cannot tell a working gate from a broken one.
 */
describe('endpoints are not registered when nothing can authenticate them', () => {
	let restoreEnv: (() => void) | undefined

	afterEach(() => {
		restoreEnv?.()
		restoreEnv = undefined
	})

	async function archiverServer(
		extra: Partial<Parameters<typeof createServer>[0]> = {},
	) {
		const pool = await getTestConnection()
		await seedAuditLog(pool)
		return createServer({
			pool,
			enableArchiver: true,
			archiverConfig: ARCHIVER_CONFIG,
			serverless: true,
			...extra,
		})
	}

	test('archiver endpoints are absent with no JWT and no cron secret', async () => {
		restoreEnv = withEnv({
			PG_HISTORY_JWT_SECRET: undefined,
			CRON_SECRET: undefined,
		})
		const { app } = await archiverServer()

		// 404, not 401: the route is never registered, so its existence does not
		// even confirm that this deployment runs an archiver.
		expect((await app.request('/api/stats')).status).toBe(404)
		expect((await app.request('/api/health/detailed')).status).toBe(404)
		expect((await app.request('/api/archive', { method: 'POST' })).status).toBe(
			404,
		)
	})

	test('allowUnauthenticated is the explicit opt-in that registers them', async () => {
		restoreEnv = withEnv({
			PG_HISTORY_JWT_SECRET: undefined,
			CRON_SECRET: undefined,
		})
		const { app } = await archiverServer({ allowUnauthenticated: true })

		expect((await app.request('/api/stats')).status).toBe(200)
		expect((await app.request('/api/health/detailed')).status).toBe(200)
	})

	test('a cron secret alone authenticates the stats endpoints', async () => {
		restoreEnv = withEnv({
			PG_HISTORY_JWT_SECRET: undefined,
			CRON_SECRET: undefined,
		})
		const { app } = await archiverServer({
			archiveCronSecret: 'cron-secret-value',
		})

		expect((await app.request('/api/stats')).status).toBe(401)
		const authorized = await app.request('/api/stats', {
			headers: { Authorization: 'Bearer cron-secret-value' },
		})
		expect(authorized.status).toBe(200)
	})
})

describe('/openapi is registered only when something guards it', () => {
	let restoreEnv: (() => void) | undefined

	afterEach(() => {
		restoreEnv?.()
		restoreEnv = undefined
	})

	async function server(
		extra: Partial<Parameters<typeof createServer>[0]> = {},
	) {
		const pool = await getTestConnection()
		await pool.query(
			`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)`,
		)
		return createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] },
			serverless: true,
			...extra,
		})
	}

	test('absent in a cron-only deployment, so the API shape does not leak', async () => {
		restoreEnv = withEnv({ PG_HISTORY_JWT_SECRET: undefined })
		// A real cron-only deployment: archiver on, history API off (with it on
		// and no JWT secret, createServer refuses to start at all), authenticated
		// solely by the cron secret.
		const pool = await getTestConnection()
		await seedAuditLog(pool)
		const { app } = await createServer({
			pool,
			enableArchiver: true,
			archiverConfig: ARCHIVER_CONFIG,
			archiveCronSecret: 'cron-secret-value',
			serverless: true,
		})
		expect((await app.request('/openapi')).status).toBe(404)
	})

	test('public when explicitly opted into', async () => {
		restoreEnv = withEnv({ PG_HISTORY_JWT_SECRET: undefined })
		const { app } = await server({
			allowUnauthenticated: true,
			publicOpenApi: true,
		})
		expect((await app.request('/openapi')).status).toBe(200)
	})

	test('JWT-gated when a secret is configured', async () => {
		restoreEnv = withEnv({ PG_HISTORY_JWT_SECRET: 'openapi-secret' })
		const { app } = await server()

		expect((await app.request('/openapi')).status).toBe(401)

		const token = await sign({ sub: 'someone' }, 'openapi-secret')
		const allowed = await app.request('/openapi', {
			headers: { Authorization: `Bearer ${token}` },
		})
		expect(allowed.status).toBe(200)
	})

	test('the cron secret does not unlock it', async () => {
		restoreEnv = withEnv({ PG_HISTORY_JWT_SECRET: 'openapi-secret' })
		const pool = await getTestConnection()
		await seedAuditLog(pool)
		const { app } = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] },
			enableArchiver: true,
			archiverConfig: ARCHIVER_CONFIG,
			archiveCronSecret: 'cron-secret-value',
			serverless: true,
		})

		// /openapi is not an operational endpoint — a scheduler has no business
		// reading the API shape, and the bypass must not reach it.
		const res = await app.request('/openapi', {
			headers: { Authorization: 'Bearer cron-secret-value' },
		})
		expect(res.status).toBe(401)
	})
})

describe('request hardening', () => {
	test('oversized bodies are rejected before any handler runs', async () => {
		const pool = await getTestConnection()
		const { app } = await createServer({ pool, allowUnauthenticated: true })

		const res = await app.request('/api/history/search', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: 'x'.repeat(1024 * 1024 + 1),
		})
		expect(res.status).toBe(413)
	})

	test('every response carries the sniffing and framing headers', async () => {
		const pool = await getTestConnection()
		const { app } = await createServer({ pool, allowUnauthenticated: true })

		const res = await app.request('/health')
		expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
		expect(res.headers.get('X-Frame-Options')).toBe('DENY')
	})
})

describe('JWT issuer / audience are verified when configured', () => {
	let restoreEnv: (() => void) | undefined

	afterEach(() => {
		restoreEnv?.()
		restoreEnv = undefined
	})

	async function serverWithClaims() {
		const pool = await getTestConnection()
		await pool.query(
			`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)`,
		)
		return createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] },
			jwt: { issuer: 'https://issuer.example', audience: 'pg-history' },
			serverless: true,
		})
	}

	test('a token from another service sharing the secret is rejected', async () => {
		restoreEnv = withEnv({ PG_HISTORY_JWT_SECRET: 'shared-secret' })
		const { app } = await serverWithClaims()

		const foreign = await sign(
			{ sub: 'someone', iss: 'https://other.example', aud: 'other-api' },
			'shared-secret',
		)
		const res = await app.request('/api/history/users/1', {
			headers: { Authorization: `Bearer ${foreign}` },
		})
		expect(res.status).toBe(401)
	})

	test('a token minted for this API is accepted', async () => {
		restoreEnv = withEnv({ PG_HISTORY_JWT_SECRET: 'shared-secret' })
		const { app } = await serverWithClaims()

		const ours = await sign(
			{ sub: 'someone', iss: 'https://issuer.example', aud: 'pg-history' },
			'shared-secret',
		)
		const res = await app.request('/api/history/users/1', {
			headers: { Authorization: `Bearer ${ours}` },
		})
		expect(res.status).toBe(200)
	})
})

describe('rate limiting buckets by client identity', () => {
	/**
	 * The old fallback was a single global bucket whenever trustProxy was off,
	 * so one noisy client could 429 everybody else.
	 */
	test('one client exhausting its bucket does not lock out another', async () => {
		const pool = await getTestConnection()
		const { app } = await createServer({
			pool,
			allowUnauthenticated: true,
			clientIdentifier: ({ request }) =>
				new Headers(request.headers).get('x-test-client') ?? undefined,
		})

		let sawRateLimit = false
		for (let i = 0; i < 130; i++) {
			const res = await app.request('/api/stats', {
				headers: { 'x-test-client': 'noisy' },
			})
			if (res.status === 429) {
				sawRateLimit = true
				break
			}
		}
		expect(sawRateLimit).toBe(true)

		const other = await app.request('/api/stats', {
			headers: { 'x-test-client': 'quiet' },
		})
		expect(other.status).not.toBe(429)
	})

	/**
	 * Identified keys and the unidentified-traffic bucket share one Map. Without
	 * a namespace prefix, a client reporting its identity as the literal string
	 * "global" lands in the shared bucket and burns down everyone else's
	 * allowance — spoofable with one header under trustProxy.
	 */
	test('a client claiming to be "global" cannot drain the shared bucket', async () => {
		const pool = await getTestConnection()
		const { app } = await createServer({
			pool,
			allowUnauthenticated: true,
			clientIdentifier: ({ request }) =>
				new Headers(request.headers).get('x-test-client') ?? undefined,
		})

		let impostorLimited = false
		for (let i = 0; i < 130; i++) {
			const res = await app.request('/api/stats', {
				headers: { 'x-test-client': 'global' },
			})
			if (res.status === 429) {
				impostorLimited = true
				break
			}
		}
		expect(impostorLimited).toBe(true)

		// No identifying header at all — this request is the "unidentified"
		// traffic the global bucket exists for, and must be unaffected.
		const unidentified = await app.request('/api/stats')
		expect(unidentified.status).not.toBe(429)
	})
})

describe('pg-history/next is configurable in code', () => {
	let restoreEnv: (() => void) | undefined

	afterEach(() => {
		restoreEnv?.()
		restoreEnv = undefined
	})

	/**
	 * `createHandlers` exists so callers can supply what no env var can express —
	 * above all the `authorize` hook. Requiring PG_HISTORY_TABLES anyway, even
	 * when historyConfig was passed in code, defeated that.
	 */
	test('historyConfig in code replaces the PG_HISTORY_TABLES requirement', async () => {
		restoreEnv = withEnv({
			PG_HISTORY_TABLES: undefined,
			PG_HISTORY_JWT_SECRET: 'jwt-secret-value',
		})
		const pool = await getTestConnection()
		await pool.query(
			`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)`,
		)

		const { createHandlers } = await import('../src/next')
		const handlers = createHandlers({
			pool,
			historyConfig: { tables: ['users'] },
			authorize: () => false,
		})

		// Reaching /health proves the app initialised — it would otherwise have
		// thrown "PG_HISTORY_TABLES environment variable is required" and every
		// request would return 500 INIT_ERROR.
		const health = await handlers.GET(
			new Request('http://pg-history.test/health'),
		)
		expect(health.status).toBe(200)
	})

	test('the authorize hook supplied in code is enforced', async () => {
		restoreEnv = withEnv({
			PG_HISTORY_TABLES: undefined,
			PG_HISTORY_JWT_SECRET: 'jwt-secret-value',
		})
		const pool = await getTestConnection()
		await pool.query(
			`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)`,
		)

		const { createHandlers } = await import('../src/next')
		const handlers = createHandlers({
			pool,
			historyConfig: { tables: ['users'] },
			// Deny everything: a 403 proves the hook ran, which is impossible
			// through the env-only entry point.
			authorize: () => false,
		})

		const token = await sign({ sub: 'someone' }, 'jwt-secret-value')
		const res = await handlers.GET(
			new Request('http://pg-history.test/api/history/users/1', {
				headers: { Authorization: `Bearer ${token}` },
			}),
		)
		expect(res.status).toBe(403)
	})
})

describe('TRUNCATE entries are first-class', () => {
	let history: PgHistory | undefined

	afterEach(async () => {
		history = undefined
	})

	async function seedTruncate(pool: Pool): Promise<PgHistory> {
		await pool.query(
			`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)`,
		)
		const h = new PgHistory({ pool, tables: ['users'] })
		await h.setup()
		await pool.query(`INSERT INTO users (name) VALUES ('alice')`)
		await pool.query(`TRUNCATE TABLE users`)
		return h
	}

	test('search can filter for them', async () => {
		const pool = await getTestConnection()
		history = await seedTruncate(pool)

		const result = await history.search({
			tables: ['users'],
			operation: 'TRUNCATE',
		})
		expect(result.data.length).toBe(1)
		expect(result.data[0]?.operation).toBe('TRUNCATE')
	})

	test('the API accepts TRUNCATE in a search body', () => {
		const parsed = parseSearchBody({
			tables: ['users'],
			operation: 'TRUNCATE',
		})
		expect(parsed.operation).toBe('TRUNCATE')
	})

	test('reverting one explains why it cannot be undone', async () => {
		const pool = await getTestConnection()
		history = await seedTruncate(pool)

		const found = await history.search({
			tables: ['users'],
			operation: 'TRUNCATE',
		})
		const entry = found.data[0]
		expect(entry).toBeDefined()
		if (!entry) return

		// The old code fell through to the UPDATE branch and blamed missing
		// old_data, which sent the reader looking for a corrupted audit row.
		await expect(
			history.revert('users', entry.recordId, entry.id),
		).rejects.toThrow(/records a TRUNCATE/)
	})
})
