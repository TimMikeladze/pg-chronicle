import 'server-only'

import { Pool } from 'pg'

import { open, SecretKeyMismatchError, seal } from './secret-box'

/**
 * The dashboard's own store: which databases it manages, which tables in each
 * are audited, and whether that connection archives to S3.
 *
 * Why a database and not environment variables: a connection you can only add
 * by editing a deployment's environment and waiting for a redeploy is not a
 * connection you can add. Everything here used to be a `PG_CHRONICLE_*`
 * variable; the deployment now needs exactly one — a Postgres URL for this
 * registry — and every other decision is made in the UI.
 *
 * Why not the audited database itself: the dashboard manages many, and any one
 * of them can be removed. The registry outlives its entries.
 *
 * The schema is created on first use rather than by a migration step, because
 * there is no migration step to hang it off — the deployment is a one-click
 * clone whose first request may be the first time this database is touched.
 */

export const REGISTRY_TABLE = 'pg_chronicle_dashboard_connections'

export interface ArchiverSettings {
	bucket: string
	endpoint?: string
	region?: string
	accessKeyId?: string
	/** Plaintext in memory; sealed at rest. */
	secretAccessKey?: string
	retentionDays: number
	gracePeriodDays: number
	batchSize: number
}

/** A connection with its credentials decrypted. Never cross the RSC boundary with one. */
export interface Connection {
	id: string
	name: string
	databaseUrl: string
	tables: string[]
	archiver: ArchiverSettings | null
	createdAt: string
	updatedAt: string
}

/**
 * What the browser is allowed to know. The connection string is reduced to the
 * host and database name it points at — enough to tell two connections apart,
 * nothing that could be used to reach either.
 */
export interface ConnectionSummary {
	id: string
	name: string
	/** `host:port/database`, or null when the credentials could not be opened. */
	target: string | null
	tables: string[]
	archiverEnabled: boolean
	archiveBucket: string | null
	/** True when the stored credentials cannot be decrypted with the current secret. */
	sealed: boolean
	updatedAt: string
}

export class RegistryNotConfiguredError extends Error {
	constructor() {
		super(
			'PG_CHRONICLE_DASHBOARD_DATABASE_URL is required. The dashboard keeps its connection registry in that database.',
		)
		this.name = 'RegistryNotConfiguredError'
	}
}

export class DuplicateConnectionError extends Error {
	constructor(name: string) {
		super(`A connection named “${name}” already exists.`)
		this.name = 'DuplicateConnectionError'
	}
}

/*
 * One pool per process, created lazily so importing this module never opens a
 * socket — `next build` imports every route module, and a build should not need
 * a reachable database.
 */
let pool: Pool | null = null
let schemaReady: Promise<void> | null = null

export function registryConfigured(): boolean {
	return Boolean(process.env.PG_CHRONICLE_DASHBOARD_DATABASE_URL?.trim())
}

function registryPool(): Pool {
	if (pool) return pool
	const url = process.env.PG_CHRONICLE_DASHBOARD_DATABASE_URL?.trim()
	if (!url) throw new RegistryNotConfiguredError()

	pool = new Pool({
		connectionString: url,
		// The registry is read once or twice per render and written by hand. It
		// does not need the audited connections' headroom.
		max: 2,
		connectionTimeoutMillis: 10_000,
		idleTimeoutMillis: 30_000,
		// Client-side, not `statement_timeout`. The registry is routinely a pooled
		// endpoint (Neon, Supabase, PgBouncer) — exactly what this deployment
		// recommends — and a transaction-mode pooler rejects the connection
		// outright with "unsupported startup parameter: statement_timeout".
		// `query_timeout` is a timer in the driver, so it bounds a wedged query
		// everywhere, at the cost of the backend noticing on its next write.
		query_timeout: 15_000,
	})
	// An idle client killed by the database (a proxy timeout, a failover) emits
	// 'error' on the pool. Unhandled, that is a process-level crash.
	pool.on('error', (error) => {
		console.error('pg-chronicle dashboard registry pool error', error)
	})
	return pool
}

async function ensureSchema(): Promise<void> {
	if (schemaReady) return schemaReady
	schemaReady = (async () => {
		await registryPool().query(`
			CREATE TABLE IF NOT EXISTS ${REGISTRY_TABLE} (
				id           text PRIMARY KEY,
				name         text NOT NULL,
				database_url text NOT NULL,
				tables       text[] NOT NULL DEFAULT '{}',
				archiver     jsonb,
				created_at   timestamptz NOT NULL DEFAULT now(),
				updated_at   timestamptz NOT NULL DEFAULT now()
			)
		`)
		// Names are how an operator tells connections apart in the switcher, so
		// two identical ones would make the UI ambiguous rather than merely untidy.
		await registryPool().query(
			`CREATE UNIQUE INDEX IF NOT EXISTS ${REGISTRY_TABLE}_name_key ON ${REGISTRY_TABLE} (lower(name))`,
		)
	})().catch((error) => {
		// Reset so the next request retries rather than caching the rejection for
		// the life of the instance.
		schemaReady = null
		throw error
	})
	return schemaReady
}

interface Row {
	id: string
	name: string
	database_url: string
	tables: string[]
	archiver: StoredArchiver | null
	created_at: Date
	updated_at: Date
}

/** The jsonb shape, whose `secretAccessKey` is sealed rather than plaintext. */
interface StoredArchiver extends Omit<ArchiverSettings, 'secretAccessKey'> {
	secretAccessKey?: string
}

function hydrate(row: Row): Connection {
	const archiver = row.archiver
	return {
		id: row.id,
		name: row.name,
		databaseUrl: open(row.database_url),
		tables: row.tables,
		archiver: archiver
			? {
					...archiver,
					secretAccessKey: archiver.secretAccessKey
						? open(archiver.secretAccessKey)
						: undefined,
				}
			: null,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
	}
}

/**
 * `host:port/database` from a connection string, for display only.
 *
 * Deliberately built field by field rather than by stripping the password out
 * of the URL: a redaction that misses a case leaks a credential into the DOM,
 * whereas naming the three fields that may be shown cannot.
 */
export function describeTarget(databaseUrl: string): string | null {
	try {
		const url = new URL(databaseUrl)
		const database = url.pathname.replace(/^\//, '') || 'postgres'
		return `${url.hostname}${url.port ? `:${url.port}` : ''}/${database}`
	} catch {
		return null
	}
}

function summarize(row: Row): ConnectionSummary {
	let target: string | null = null
	let sealed = false
	try {
		target = describeTarget(open(row.database_url))
	} catch (error) {
		// A rotated secret must not blank the whole page: the connection is still
		// listed, marked unreadable, and can be repaired by re-entering its URL.
		sealed = error instanceof SecretKeyMismatchError
		if (!sealed) throw error
	}
	return {
		id: row.id,
		name: row.name,
		target,
		tables: row.tables,
		archiverEnabled: Boolean(row.archiver),
		archiveBucket: row.archiver?.bucket ?? null,
		sealed,
		updatedAt: row.updated_at.toISOString(),
	}
}

const SELECT = `SELECT id, name, database_url, tables, archiver, created_at, updated_at FROM ${REGISTRY_TABLE}`

export async function listConnections(): Promise<ConnectionSummary[]> {
	await ensureSchema()
	const result = await registryPool().query<Row>(`${SELECT} ORDER BY name ASC`)
	return result.rows.map(summarize)
}

export async function getConnection(id: string): Promise<Connection | null> {
	await ensureSchema()
	const result = await registryPool().query<Row>(`${SELECT} WHERE id = $1`, [
		id,
	])
	const row = result.rows[0]
	return row ? hydrate(row) : null
}

/**
 * Everything the edit form needs and nothing more.
 *
 * The form never renders a credential back into the page, so it has no reason
 * to load one — which also makes it the one view that still works when the
 * stored secrets cannot be decrypted. Repairing a connection after a secret
 * rotation is then an edit rather than a delete-and-retype.
 */
export interface ConnectionDraft {
	id: string
	name: string
	tables: string[]
	/** `host:port/database`, or null when the connection string is sealed. */
	target: string | null
	sealed: boolean
	hasStoredSecretKey: boolean
	archiver: {
		bucket: string
		endpoint: string
		region: string
		accessKeyId: string
		retentionDays: number
		gracePeriodDays: number
		batchSize: number
	} | null
}

export async function getConnectionDraft(
	id: string,
): Promise<ConnectionDraft | null> {
	await ensureSchema()
	const result = await registryPool().query<Row>(`${SELECT} WHERE id = $1`, [
		id,
	])
	const row = result.rows[0]
	if (!row) return null

	const summary = summarize(row)
	const archiver = row.archiver
	return {
		id: row.id,
		name: row.name,
		tables: row.tables,
		target: summary.target,
		sealed: summary.sealed,
		hasStoredSecretKey: Boolean(archiver?.secretAccessKey),
		archiver: archiver
			? {
					bucket: archiver.bucket,
					endpoint: archiver.endpoint ?? '',
					region: archiver.region ?? '',
					accessKeyId: archiver.accessKeyId ?? '',
					retentionDays: archiver.retentionDays,
					gracePeriodDays: archiver.gracePeriodDays,
					batchSize: archiver.batchSize,
				}
			: null,
	}
}

/**
 * Every connection with archival configured — the set the cron route walks.
 *
 * A sealed row is reported rather than thrown, because this list is walked
 * unattended: one connection whose credentials predate a secret rotation must
 * not stop the nightly archival of every other database, and it must be named
 * in the response rather than disappearing from it.
 */
export type ArchivingConnection =
	| { id: string; name: string; connection: Connection }
	| { id: string; name: string; connection: null; sealed: true }

export async function listArchivingConnections(): Promise<
	ArchivingConnection[]
> {
	await ensureSchema()
	const result = await registryPool().query<Row>(
		`${SELECT} WHERE archiver IS NOT NULL ORDER BY name ASC`,
	)
	return result.rows.map((row) => {
		try {
			return { id: row.id, name: row.name, connection: hydrate(row) }
		} catch (error) {
			if (error instanceof SecretKeyMismatchError) {
				return { id: row.id, name: row.name, connection: null, sealed: true }
			}
			throw error
		}
	})
}

export interface ConnectionInput {
	name: string
	databaseUrl: string
	tables: string[]
	archiver: ArchiverSettings | null
}

/**
 * URL-safe, human-readable, and stable: the id is in every link to a
 * connection's pages, so it is derived from the name once at creation and never
 * recomputed — renaming a connection must not break a bookmark.
 */
function slugify(name: string): string {
	return name
		.toLowerCase()
		.normalize('NFKD')
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 48)
}

function storedArchiver(
	archiver: ArchiverSettings | null,
): StoredArchiver | null {
	if (!archiver) return null
	return {
		...archiver,
		secretAccessKey: archiver.secretAccessKey
			? seal(archiver.secretAccessKey)
			: undefined,
	}
}

export async function createConnection(
	input: ConnectionInput,
): Promise<Connection> {
	await ensureSchema()
	const base = slugify(input.name) || 'connection'

	// Collisions are rare enough that a bounded retry beats a sequence or a
	// random suffix, both of which would cost readability in every URL.
	for (let attempt = 0; attempt < 20; attempt++) {
		const id = attempt === 0 ? base : `${base}-${attempt + 1}`
		try {
			const result = await registryPool().query<Row>(
				`INSERT INTO ${REGISTRY_TABLE} (id, name, database_url, tables, archiver)
				 VALUES ($1, $2, $3, $4, $5)
				 RETURNING id, name, database_url, tables, archiver, created_at, updated_at`,
				[
					id,
					input.name,
					seal(input.databaseUrl),
					input.tables,
					storedArchiver(input.archiver),
				],
			)
			// biome-ignore lint/style/noNonNullAssertion: RETURNING on a successful INSERT always yields the row.
			return hydrate(result.rows[0]!)
		} catch (error) {
			const code = (error as { code?: string }).code
			if (code !== '23505') throw error
			// Unique violation. The name index and the primary key are different
			// constraints with different remedies: a duplicate name is the
			// operator's to fix, a duplicate id is ours.
			const constraint = (error as { constraint?: string }).constraint
			if (constraint?.includes('name')) {
				throw new DuplicateConnectionError(input.name)
			}
		}
	}
	throw new Error('Could not allocate an id for this connection.')
}

export async function updateConnection(
	id: string,
	input: ConnectionInput,
): Promise<Connection | null> {
	await ensureSchema()
	try {
		const result = await registryPool().query<Row>(
			`UPDATE ${REGISTRY_TABLE}
			 SET name = $2, database_url = $3, tables = $4, archiver = $5, updated_at = now()
			 WHERE id = $1
			 RETURNING id, name, database_url, tables, archiver, created_at, updated_at`,
			[
				id,
				input.name,
				seal(input.databaseUrl),
				input.tables,
				storedArchiver(input.archiver),
			],
		)
		const row = result.rows[0]
		return row ? hydrate(row) : null
	} catch (error) {
		if ((error as { code?: string }).code === '23505') {
			throw new DuplicateConnectionError(input.name)
		}
		throw error
	}
}

export async function deleteConnection(id: string): Promise<boolean> {
	await ensureSchema()
	const result = await registryPool().query(
		`DELETE FROM ${REGISTRY_TABLE} WHERE id = $1`,
		[id],
	)
	return (result.rowCount ?? 0) > 0
}

/** Registry reachability, for the platform health probe. */
export async function registryHealthy(): Promise<boolean> {
	try {
		await registryPool().query('SELECT 1')
		return true
	} catch {
		return false
	}
}
