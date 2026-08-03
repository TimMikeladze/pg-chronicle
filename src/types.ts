import type { Pool } from 'pg'
import type { Logger } from './logger'

export interface PgHistoryConfig {
	/** List of tables to track history */
	tables: string[]

	/** Provide connection string (e.g., 'postgres://user:pass@localhost:5432/db') */
	connection?: string

	/** Or provide an existing Pool connection instance */
	pool?: Pool

	/**
	 * Per-table column exclusion list. Listed columns are stripped from
	 * `old_data` / `new_data` before insertion into audit_log. Use this to
	 * keep secrets and PII (passwords, API tokens, SSNs, etc.) out of audit
	 * history. Column names must match the source table's column names
	 * exactly. Identifiers are validated against the standard
	 * [a-zA-Z0-9_] allowlist before interpolation into PL/pgSQL.
	 *
	 * Example: `{ users: ['password_hash', 'ssn'] }`
	 */
	excludeColumns?: Record<string, string[]>

	/**
	 * Optional logger for operational messages. Defaults to console-based logger.
	 * Pass silentLogger (from './logger') in tests to suppress output.
	 */
	logger?: Logger

	/**
	 * Maximum number of concurrent `search()` queries. `search()` can run
	 * unindexed ILIKE full scans that pin a pool connection for seconds; without
	 * a cap a handful of concurrent searches exhaust a small pool and starve every
	 * other query (a cheap DoS). Excess searches reject with
	 * {@link SearchConcurrencyLimitError} rather than queueing unbounded.
	 * Default: 4. Set to 0 to disable the limit.
	 */
	maxConcurrentSearches?: number

	/**
	 * When true, `setup()` installs a `BEFORE UPDATE OR DELETE` guard trigger on
	 * `audit_log` that rejects any UPDATE/DELETE unless the session set
	 * `pg_history.maintenance = 'on'`. This makes the trail append-only for the
	 * application, blocking accidental or casual tampering. The pg-history
	 * archiver sets that flag automatically, so archival still works.
	 *
	 * NOTE: this is tamper-RESISTANCE, not cryptographic tamper-evidence — a role
	 * that can write the table can also set the flag. For true WORM guarantees,
	 * additionally `REVOKE UPDATE, DELETE, TRUNCATE ON audit_log` from the
	 * application role (running the archiver under a separate privileged role) and
	 * consider a per-row hash chain. Default: false (opt-in, so it never conflicts
	 * with deployments that manage `audit_log` directly).
	 */
	appendOnly?: boolean

	/**
	 * When true, `setup()` refuses to install a trigger on a table that has no
	 * primary key. Such tables get a per-row md5 `record_id` that changes on every
	 * UPDATE, so their history entries cannot be correlated into a single record's
	 * timeline. Default false: a table without a PK is still audited, but a warning
	 * is logged (it is never silent). Set true to fail fast instead.
	 */
	requirePrimaryKey?: boolean
}

export interface AuditEntry {
	id: string
	tableName: string
	recordId: string
	operation: 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'
	changedAt: Date
	oldData: Record<string, unknown> | null
	newData: Record<string, unknown> | null
	/** Database role that performed the change (`current_user` at trigger time). */
	dbUser: string | null
	/**
	 * Application-level actor, read from the `pg_history.actor` session setting.
	 * NULL unless the application ran `SET LOCAL pg_history.actor = '<id>'`
	 * before the DML statement.
	 */
	appActor: string | null
	/** Client network address (`inet_client_addr()`), NULL for local socket connections. */
	clientAddr: string | null
}

export interface PaginatedResult<T> {
	data: T[]
	nextCursor: string | null
	hasMore: boolean
}

export interface GetHistoryOptions {
	limit?: number
	cursor?: string
	order?: 'asc' | 'desc'
}

/**
 * Opaque cursor for {@link PgHistory.search} pagination.
 *
 * **Do not mix with `getHistory()` cursors.** `search()` always paginates
 * in descending ID order (`id < cursor`). Reusing an ascending `getHistory()`
 * cursor here silently produces an empty second page because the direction
 * is incompatible.
 */
declare const _searchCursorBrand: unique symbol
export type SearchCursor = string & { readonly [_searchCursorBrand]: true }

/**
 * Paginated result from {@link PgHistory.search}. The `nextCursor` field is
 * typed as {@link SearchCursor} — only pass it back to `search()`, never to
 * `getHistory()`.
 */
export interface SearchPaginatedResult<T> {
	data: T[]
	nextCursor: SearchCursor | null
	hasMore: boolean
}

export interface SearchOptions {
	tables: string[]
	query?: string
	operation?: 'INSERT' | 'UPDATE' | 'DELETE'
	dateFrom?: Date
	dateTo?: Date
	limit?: number
	/**
	 * Opaque cursor for forward pagination. Results are always returned in
	 * descending ID order (newest first); passing a cursor advances to the
	 * next older page. Use `getHistory` when ascending order is required.
	 *
	 * **Only pass values returned by `search()`** — typed as {@link SearchCursor}
	 * to prevent accidental reuse of `getHistory()` cursors which use a different
	 * sort direction and produce silently empty pages.
	 */
	cursor?: SearchCursor
}

export interface ArchiverConfig {
	/** Database connection string */
	connection?: string

	/** Or provide existing Pool connection */
	pool?: Pool

	/** S3 configuration */
	s3: S3Config

	/** Retention policies */
	retention: RetentionConfig

	/** Grace period before deletion (days). 0 = no grace (purge as soon as the S3 backup is confirmed). */
	gracePeriod: number

	/** Batch size for processing (default: 10000) */
	batchSize?: number

	/**
	 * Soft memory cap per batch in bytes. After claim, records exceeding this
	 * cumulative serialized size are released back to be re-claimed on the next
	 * run. Defends against OOM on tables with very large jsonb payloads —
	 * batchSize alone is insufficient because a single row's old_data/new_data
	 * can be megabytes. Default: 64 MiB. Peak process memory is roughly this ×3
	 * (decoded JS objects + Parquet buffer + whole-file upload buffer), so keep
	 * it well under the VM memory limit.
	 */
	maxBatchBytes?: number

	/**
	 * Minutes after which a claim_id is considered stale and reapStaleClaims()
	 * will release it. Set well above the worst-case S3 upload + DB latency for
	 * a batch — if the reaper resets a claim while finalize is still running,
	 * the batch is retried under a fresh claim and one S3 file is wasted.
	 * Default: 30.
	 */
	staleClaimMinutes?: number

	/**
	 * Optional logger for operational messages. Defaults to console-based logger.
	 * Pass silentLogger (from './logger') in tests to suppress output.
	 */
	logger?: Logger
}

/**
 * Orchestrator configuration — replaces the positional constructor arguments
 * to avoid easy swap-order bugs.
 */
export interface OrchestratorConfig {
	s3: S3Config
	retention: RetentionConfig
	gracePeriod: number
	/** Batch size for processing (default: 10000). Matches ArchiverConfig.batchSize. */
	batchSize?: number
	logger?: Logger
	/**
	 * Optional explicit connection string for the standalone advisory-lock
	 * client. When omitted, the orchestrator derives the connection from the
	 * pool's internal options — an undocumented API that may silently fall back
	 * to environment variables if the pool was not configured with an explicit
	 * connectionString. Provide this when you need certainty that the lock
	 * client connects to the same database as the pool.
	 */
	lockConnectionString?: string
}

export interface S3Config {
	bucket: string
	accessKeyId?: string
	secretAccessKey?: string
	endpoint?: string
	region?: string
}

export interface RetentionConfig {
	/** Global default retention in days */
	default: number

	/** Per-table overrides */
	tables?: Record<string, number>
}

/**
 * Context passed to {@link ServerConfig.authorize} for every history request.
 * `operation` is the API action, not the audited SQL operation.
 */
export interface AuthorizeContext {
	/** JWT `sub` claim when a token was presented, otherwise undefined. */
	actor: string | undefined
	/** Target table (already validated against the configured allowlist). */
	table: string
	/** Target record id — present for reads and reverts, absent for search. */
	recordId?: string
	/** The API action being authorized. */
	action: 'read' | 'search' | 'revert'
	/** Full decoded JWT payload when available, for custom claim checks. */
	jwtPayload?: Record<string, unknown>
}

/**
 * Authorization callback. Return `false` (or throw) to deny a request with 403.
 * Without this hook the server performs authentication only — any valid token
 * can access every record of every configured table. Provide it to enforce
 * per-tenant / per-record ownership.
 */
export type AuthorizeFn = (ctx: AuthorizeContext) => boolean | Promise<boolean>

export interface ServerConfig {
	/** PostgreSQL connection pool */
	pool: Pool

	/**
	 * Server port (default: 3001).
	 *
	 * NOTE: `createServer()` does NOT listen on this port — it only builds the
	 * Hono app and returns `{app, dispose}`. The caller is responsible for
	 * binding (e.g. `Bun.serve({port, fetch: app.fetch})` in `main.ts`).
	 * `port` is read here only as a fallback for the OpenAPI `servers[].url`
	 * field when `baseUrl` and `VERCEL_URL` are unset.
	 */
	port?: number

	/**
	 * Enable the S3 archiver integration. When true, old audit records are
	 * compressed to Parquet files in S3 and pruned from the database according
	 * to the retention policy in `archiverConfig`.
	 */
	enableArchiver?: boolean

	/**
	 * Archiver configuration — required when `enableArchiver` is true.
	 * Controls the S3 destination, retention policy, grace period, and batch size.
	 */
	archiverConfig?: {
		s3: S3Config
		retention: RetentionConfig
		gracePeriod: number
		/** Batch size for processing (default: 10000) */
		batchSize?: number
	}

	/** Run options forwarded to the archiver (only used if enableArchiver is true). */
	runOptions?: RunOptions

	/**
	 * Background archival retry policy. Defaults to 4 attempts with delays
	 * [5s, 15s, 60s]. Set `maxAttempts: 1` to disable retry; useful in tests
	 * or for callers that prefer one-shot semantics + external scheduling.
	 */
	archivalRetry?: {
		/** Total attempts including the initial one. Default 4. */
		maxAttempts?: number
		/** Delays between attempts in ms. Length must equal maxAttempts - 1. Default [5000, 15000, 60000]. */
		delays?: number[]
	}

	/**
	 * Enable the PgHistory REST API. When true, `/api/history` and `/api/search`
	 * endpoints are registered on the Hono app.
	 */
	enableHistory?: boolean

	/**
	 * PgHistory configuration — required when `enableHistory` is true.
	 * Lists the tables whose audit triggers and history endpoints are activated.
	 */
	historyConfig?: {
		tables: string[]
	}

	/**
	 * Serverless mode. When true:
	 * - Skips background archival (use POST /api/archive or external cron instead)
	 * - Skips in-memory rate limiting (handle at API gateway level)
	 */
	serverless?: boolean

	/**
	 * Bearer token secret for the `POST /api/archive` cron endpoint.
	 * The endpoint is only registered when this value or `PG_HISTORY_JWT_SECRET`
	 * is set — omitting both disables the route entirely for security.
	 */
	archiveCronSecret?: string

	/**
	 * Base URL of the deployment (e.g. `https://api.example.com`).
	 * Used as the server URL in the OpenAPI schema. Falls back to
	 * `VERCEL_URL` env var or `http://localhost:<port>` when not set.
	 */
	baseUrl?: string

	/** Optional injectable logger (defaults to consoleLogger) */
	logger?: Logger

	/**
	 * Allow the history/revert endpoints to be served without authentication.
	 * `createServer` FAILS CLOSED: when `enableHistory` is true and no
	 * `PG_HISTORY_JWT_SECRET` is configured, it throws at startup unless this is
	 * explicitly set to `true`. Use only for local development or a fully trusted
	 * private network. Never enable on a public deployment.
	 */
	allowUnauthenticated?: boolean

	/**
	 * Authorization hook invoked before every history read/search/revert. Return
	 * false or throw to reject with 403. Without it, authentication grants blanket
	 * access to all records of all configured tables (no tenant isolation).
	 */
	authorize?: AuthorizeFn

	/**
	 * Trust the `x-forwarded-for` / `x-real-ip` headers for per-client rate
	 * limiting. These headers are client-spoofable, so they may only be trusted
	 * behind a reverse proxy that overwrites them. Default false: when false the
	 * rate limiter falls back to a single global bucket (a coarse but
	 * unspoofable backstop) instead of per-IP buckets.
	 */
	trustProxy?: boolean

	/**
	 * Expose /openapi endpoint unauthenticated (default: false).
	 * When false, the OpenAPI schema requires the same JWT as /api/* routes
	 * to prevent leaking the API shape to unauthenticated callers.
	 */
	publicOpenApi?: boolean

	/**
	 * Optional CORS configuration. When set, the server applies `hono/cors`
	 * to all routes. Omit to disable CORS entirely (the default — appropriate
	 * for server-to-server use).
	 *
	 * - `origin`: literal origin, list of origins, '*', or a predicate
	 * - `credentials`: when true, sets Access-Control-Allow-Credentials
	 */
	cors?: {
		origin: string | string[] | ((origin: string) => string | null | undefined)
		credentials?: boolean
		allowMethods?: string[]
		allowHeaders?: string[]
	}
}

export interface OrchestratorStats {
	tables: string[]
	totalRecordsArchived: number
	totalRecordsSoftDeleted: number
	totalRecordsHardDeleted: number
	errors: Array<{
		table: string
		operation: string
		error: string
	}>
	durationMs: number
}

export interface TableStats {
	tableName: string
	recordsArchived: number
	recordsSoftDeleted: number
	recordsHardDeleted: number
	durationMs: number
	/** True when the table was skipped because another instance held its lock. */
	skipped?: boolean
}

export interface ErrorResponse {
	error: {
		code: string
		message: string
		details?: unknown
	}
}

export interface RunOptions {
	dryRun?: boolean
	targetTable?: string
}
