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

export interface SearchOptions {
	tables: string[]
	query?: string
	operation?: 'INSERT' | 'UPDATE' | 'DELETE'
	dateFrom?: Date
	dateTo?: Date
	limit?: number
	cursor?: string
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

	/** Enable archiver integration */
	enableArchiver?: boolean

	/** Archiver configuration (required if enableArchiver is true) */
	archiverConfig?: {
		s3: S3Config
		retention: RetentionConfig
		gracePeriod: number
		/** Batch size for processing (default: 10000) — now optional for consistency with ArchiverConfig */
		batchSize?: number
	}

	/** Run options for archiver (only used if enableArchiver is true) */
	runOptions?: RunOptions

	/** Enable PgHistory API integration */
	enableHistory?: boolean

	/** PgHistory configuration (required if enableHistory is true) */
	historyConfig?: {
		tables: string[]
	}

	/**
	 * Serverless mode. When true:
	 * - Skips background archival (use POST /api/archive or external cron instead)
	 * - Skips in-memory rate limiting (handle at API gateway level)
	 */
	serverless?: boolean

	/** Secret for authenticating cron/archive triggers (POST /api/archive) */
	archiveCronSecret?: string

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
