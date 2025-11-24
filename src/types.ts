import type { Pool } from 'pg'

export interface PgHistoryConfig {
	/** List of tables to track history */
	tables: string[]

	/** Provide connection string (e.g., 'postgres://user:pass@localhost:5432/db') */
	connection?: string

	/** Or provide an existing Pool connection instance */
	pool?: Pool
}

export interface AuditEntry {
	id: string
	tableName: string
	recordId: string
	operation: 'INSERT' | 'UPDATE' | 'DELETE'
	changedAt: Date
	oldData: Record<string, unknown> | null
	newData: Record<string, unknown> | null
	changedBy: string | null
	metadata: Record<string, unknown> | null
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
	changedBy?: string
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

export interface ArchiveMetadata {
	id: number
	tableName: string
	archiveDate: Date
	s3Path: string
	recordCount: number
	fileSize: number
	archivedAt: Date
	status: 'completed' | 'failed' | 'in_progress'
	errorMessage: string | null
}

export interface ArchiveBatch {
	tableName: string
	records: Array<Record<string, unknown>>
	startDate: Date
	endDate: Date
}

export interface ArchiveResult {
	status: 'completed' | 'failed' | 'partial'
	summary: ArchiveSummary
	duration: number
}

export interface ArchiveSummary {
	totalRecords: number
	archivedRecords: number
	failedRecords: number
	tables: Record<string, TableArchiveSummary>
}

export interface TableArchiveSummary {
	records: number
	files: number
	size: number
}

export interface ConfigFile {
	database: {
		url: string
	}
	s3: {
		bucket: string
		endpoint?: string
		region?: string
		accessKeyId?: string
		secretAccessKey?: string
	}
	retention: {
		default: number
		tables?: Record<string, number>
	}
	gracePeriod: number
	batchSize: number
	healthPort?: number
}

export interface LoadConfigOptions {
	configPath: string
	overrides?: Partial<ConfigFile>
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

export interface RunOptions {
	dryRun?: boolean
	targetTable?: string
	skipS3Upload?: boolean // For testing
}
