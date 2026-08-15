export {
	AuditEntryNotFoundError,
	AuthorizationError,
	PgChronicleError,
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
export { PgChronicle } from './PgChronicle'
export {
	type ArchiveFile,
	type BatchResult,
	PgChronicleArchiver,
} from './PgChronicleArchiver'
// Decoding an archived Parquet file is part of the product, not an internal:
// archived history is filtered out of getHistory/search and eventually deleted
// from Postgres, so these are how it is read back. Prefer
// PgChronicleArchiver.listArchives/readArchive, which handle S3 and checksums;
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
	PgChronicleConfig,
	RetentionConfig,
	RunOptions,
	S3Config,
	SearchCursor,
	SearchOptions,
	SearchPaginatedResult,
	ServerConfig,
	TableStats,
} from './types'
