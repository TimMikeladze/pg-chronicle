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
	 * Optional logger for operational messages. Defaults to console-based logger.
	 * Pass silentLogger (from './logger') in tests to suppress output.
	 */
	logger?: Logger
}

export interface AuditEntry {
	id: string
	tableName: string
	recordId: string
	operation: 'INSERT' | 'UPDATE' | 'DELETE'
	changedAt: Date
	oldData: Record<string, unknown> | null
	newData: Record<string, unknown> | null
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

	/** Grace period before deletion (days) */
	gracePeriod: number

	/** Batch size for processing (default: 10000) */
	batchSize?: number

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
	batchSize: number
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

export interface ServerConfig {
	/** PostgreSQL connection pool */
	pool: Pool

	/** Server port (default: 3001) */
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
	 * Expose /openapi endpoint unauthenticated (default: false).
	 * When false, the OpenAPI schema requires the same JWT as /api/* routes
	 * to prevent leaking the API shape to unauthenticated callers.
	 */
	publicOpenApi?: boolean
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
