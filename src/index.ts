export {
	AuditEntryNotFoundError,
	AuthorizationError,
	PgHistoryError,
	RevertError,
	SearchConcurrencyLimitError,
	SetupRequiredError,
	TableNotConfiguredError,
	ValidationError,
} from './errors'
export {
	consoleLogger,
	type LogContext,
	type Logger,
	type LogLevel,
	silentLogger,
} from './logger'
export { Orchestrator } from './orchestrator'
export { PgHistory } from './PgHistory'
export {
	type ArchiveFile,
	type BatchResult,
	PgHistoryArchiver,
} from './PgHistoryArchiver'
// Decoding an archived Parquet file is part of the product, not an internal:
// archived history is filtered out of getHistory/search and eventually deleted
// from Postgres, so these are how it is read back. Prefer
// PgHistoryArchiver.listArchives/readArchive, which handle S3 and checksums;
// reach for these directly only for files you already have on disk.
export { readParquet, writeParquet } from './parquet'
export { createServer } from './server'
export type {
	ArchiverConfig,
	AuditEntry,
	AuthorizeContext,
	AuthorizeFn,
	ClientIdentifierFn,
	ClientIdentityContext,
	GetHistoryOptions,
	OrchestratorConfig,
	OrchestratorStats,
	PaginatedResult,
	PgHistoryConfig,
	RetentionConfig,
	RunOptions,
	S3Config,
	SearchCursor,
	SearchOptions,
	SearchPaginatedResult,
	ServerConfig,
	TableStats,
} from './types'
