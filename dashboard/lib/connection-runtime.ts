import 'server-only'

import { Pool } from 'pg'
import { createServer } from 'pg-chronicle'

import type { Connection } from './registry'

/**
 * One pg-chronicle server per managed connection, built on demand and cached
 * for the life of the instance.
 *
 * The library's own Next entry point derives a single server from environment
 * variables at import time. That is exactly the constraint this dashboard
 * exists to remove, so it calls `createServer` directly instead and supplies
 * the pool and config from the registry row.
 *
 * `createServer` installs the audit triggers as part of initialisation, which
 * is what makes "add a connection in the UI" complete: naming a database and
 * its tables is what starts auditing them.
 */

type Runtime = Awaited<ReturnType<typeof createServer>>
export type ConnectionApp = Runtime['app']

interface Entry {
	/** Rebuilt when the registry row changes — see {@link fingerprint}. */
	fingerprint: string
	pool: Pool
	runtime: Runtime
}

/**
 * Bounded so a large registry cannot open unbounded pools on a warm instance.
 * Least-recently-used is evicted and its pool closed; the next request for it
 * pays one reconnect, which is the same cost as a cold start.
 */
const MAX_RUNTIMES = 8

const entries = new Map<string, Entry>()
const building = new Map<string, Promise<Entry>>()

/**
 * Floored at 2, not 1. `setup()` holds a client while acquiring another, so a
 * single-connection pool deadlocks and then fails with pg's opaque "timeout
 * exceeded when trying to connect" — which reads as an unreachable host and
 * sends the operator to check their firewall.
 */
function poolMax(): number {
	const parsed = Number.parseInt(process.env.PG_CHRONICLE_POOL_MAX || '3', 10)
	return Number.isFinite(parsed) && parsed >= 2 ? parsed : 3
}

function statementTimeoutMs(): number {
	const parsed = Number.parseInt(
		process.env.PG_CHRONICLE_STATEMENT_TIMEOUT_MS || '30000',
		10,
	)
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : 30_000
}

/**
 * Everything that would change the built server. Editing a connection's tables
 * or credentials in the UI must take effect on the next request rather than at
 * the next cold start, and comparing this is how that happens.
 */
function fingerprint(connection: Connection): string {
	return JSON.stringify([
		connection.updatedAt,
		connection.databaseUrl,
		connection.tables,
		connection.archiver,
	])
}

async function dispose(entry: Entry): Promise<void> {
	await entry.runtime.dispose().catch(() => {})
	await entry.pool.end().catch(() => {})
}

async function build(connection: Connection): Promise<Entry> {
	const pool = new Pool({
		connectionString: connection.databaseUrl,
		max: poolMax(),
		connectionTimeoutMillis: 10_000,
		idleTimeoutMillis: 30_000,
		/*
		 * Bound every query so a stuck connection cannot wedge a warm instance —
		 * but client-side, not as a `statement_timeout` startup parameter. Audited
		 * databases are frequently reached through a transaction-mode pooler
		 * (Neon, Supabase, PgBouncer), which refuses the connection with
		 * "unsupported startup parameter: statement_timeout" rather than ignoring
		 * it. The library still issues `SET LOCAL statement_timeout` inside its own
		 * archival transactions, which is where a server-side bound matters and is
		 * pooler-safe.
		 */
		query_timeout: statementTimeoutMs(),
	})
	pool.on('error', (error) => {
		console.error(`pg-chronicle pool error (${connection.id})`, error)
	})

	const archiver = connection.archiver

	try {
		const runtime = await createServer({
			pool,
			// Vercel and any other request-scoped host: no background timers, no
			// in-process rate limiting. Archival runs from the cron route instead.
			serverless: true,
			enableHistory: true,
			historyConfig: { tables: connection.tables },
			enableArchiver: Boolean(archiver),
			archiverConfig: archiver
				? {
						s3: {
							bucket: archiver.bucket,
							endpoint: archiver.endpoint,
							region: archiver.region,
							accessKeyId: archiver.accessKeyId,
							secretAccessKey: archiver.secretAccessKey,
						},
						retention: { default: archiver.retentionDays },
						gracePeriod: archiver.gracePeriodDays,
						batchSize: archiver.batchSize,
						// Without this the orchestrator's advisory-lock client reads
						// `pool.options` and can silently fall back to PGHOST/PGUSER —
						// which on this deployment would point at the registry, not the
						// database being archived.
						lockConnectionString: connection.databaseUrl,
					}
				: undefined,
		})
		return { fingerprint: fingerprint(connection), pool, runtime }
	} catch (error) {
		// A pool whose server never finished initialising has no owner to close it.
		await pool.end().catch(() => {})
		throw error
	}
}

export async function connectionApp(
	connection: Connection,
): Promise<ConnectionApp> {
	const cached = entries.get(connection.id)
	if (cached) {
		if (cached.fingerprint === fingerprint(connection)) {
			// Refresh recency: Map preserves insertion order, so re-inserting moves
			// this entry to the end and makes the first key the true LRU victim.
			entries.delete(connection.id)
			entries.set(connection.id, cached)
			return cached.runtime.app
		}
		// The registry row changed. Retire the stale server rather than serving a
		// stale table allowlist or a revoked credential.
		entries.delete(connection.id)
		void dispose(cached)
	}

	// Coalesce a burst of concurrent renders onto one initialisation. Without
	// this, several server components rendering the same page each run the
	// trigger-installing DDL.
	const inFlight = building.get(connection.id)
	if (inFlight) return (await inFlight).runtime.app

	const promise = build(connection)
		.then((entry) => {
			if (entries.size >= MAX_RUNTIMES) {
				const victim = entries.keys().next().value
				if (victim !== undefined) {
					const evicted = entries.get(victim)
					entries.delete(victim)
					if (evicted) void dispose(evicted)
				}
			}
			entries.set(connection.id, entry)
			return entry
		})
		.finally(() => {
			building.delete(connection.id)
		})

	building.set(connection.id, promise)
	return (await promise).runtime.app
}

/**
 * Prove a connection works before it is written to the registry — connect,
 * then run the same initialisation a real request would, which installs the
 * audit triggers on the listed tables.
 *
 * Doing this up front rather than on first page load is what makes the form
 * honest: a wrong password, an unreachable host or a table that does not exist
 * is reported next to the field that caused it, instead of being saved and
 * discovered later as a broken page.
 *
 * @throws the underlying pg / pg-chronicle error, whose message names the
 * actual problem.
 */
export async function verifyConnection(input: {
	databaseUrl: string
	tables: string[]
}): Promise<void> {
	const pool = new Pool({
		connectionString: input.databaseUrl,
		max: poolMax(),
		connectionTimeoutMillis: 10_000,
		query_timeout: statementTimeoutMs(),
	})
	try {
		const { dispose } = await createServer({
			pool,
			serverless: true,
			enableHistory: true,
			historyConfig: { tables: input.tables },
		})
		await dispose().catch(() => {})
	} finally {
		await pool.end().catch(() => {})
	}
}

/**
 * Drop a connection's cached server. Called when it is deleted, so its pool
 * closes immediately rather than idling until the instance recycles.
 */
export async function forgetConnection(id: string): Promise<void> {
	const entry = entries.get(id)
	if (!entry) return
	entries.delete(id)
	await dispose(entry)
}
