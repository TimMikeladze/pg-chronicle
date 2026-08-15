/**
 * Wire types for the pg-chronicle REST API.
 *
 * These deliberately mirror — rather than re-export — the library's own
 * `AuditEntry` / `PaginatedResult` types, because those describe the in-process
 * shapes where timestamps are `Date`. Everything here has been through
 * `JSON.stringify`, so every date is an ISO string.
 */

export type Operation = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'

/** The three operations a caller may filter a search by. TRUNCATE is recorded but not filterable. */
export const SEARCHABLE_OPERATIONS = ['INSERT', 'UPDATE', 'DELETE'] as const

export interface AuditEntryWire {
	id: string
	tableName: string
	recordId: string
	operation: Operation
	/** ISO-8601 — `AuditEntry.changedAt` after JSON serialization. */
	changedAt: string
	oldData: Record<string, unknown> | null
	newData: Record<string, unknown> | null
	dbUser: string | null
	appActor: string | null
	clientAddr: string | null
}

export interface PaginatedWire<T> {
	data: T[]
	nextCursor: string | null
	hasMore: boolean
}

/**
 * Cursors from `getHistory` and `search` are NOT interchangeable: `search`
 * always paginates descending (`id < cursor`) while `getHistory` honours the
 * requested order. Feeding one to the other yields a silently empty page, so
 * they carry distinct brands and never share a variable.
 */
declare const historyCursorBrand: unique symbol
export type HistoryCursor = string & { readonly [historyCursorBrand]: true }

declare const searchCursorBrand: unique symbol
export type SearchCursor = string & { readonly [searchCursorBrand]: true }

export interface ArchivalStatsRow {
	tableName: string
	recordsPendingArchive: number
	recordsPendingSoftDelete: number
	recordsPendingHardDelete: number
	/** ISO-8601 or null when nothing is pending. */
	oldestUnarchivedRecord: string | null
	lastUpdated: string
}

export type ArchivalStatus = 'idle' | 'running' | 'completed' | 'failed'

export interface DetailedHealth {
	status: 'ok' | 'degraded'
	archival: {
		status: ArchivalStatus
		attempts: number
		lastCompletedAt: string | null
		lastError: string | null
	}
}

/** Every error code `createErrorResponse` can emit, per src/server.ts. */
export type ApiErrorCode =
	| 'VALIDATION_ERROR'
	| 'INVALID_TABLE'
	| 'UNAUTHORIZED'
	| 'FORBIDDEN'
	| 'NOT_FOUND'
	| 'REVERT_ERROR'
	| 'RATE_LIMITED'
	| 'DATABASE_ERROR'
	| 'ARCHIVAL_ERROR'
	// A run that exhausted its retries. Distinct from ARCHIVAL_ERROR, which is
	// the endpoint itself throwing rather than the run reporting failure.
	| 'ARCHIVAL_FAILED'
	| 'NOT_CONFIGURED'
	| 'INIT_ERROR'

export interface SearchParams {
	tables: string[]
	query?: string
	operation?: (typeof SEARCHABLE_OPERATIONS)[number]
	dateFrom?: string
	dateTo?: string
	limit?: number
	cursor?: SearchCursor
}

/**
 * Server actions can only return serializable values, so failures come back as
 * data rather than thrown errors. Every action returns this shape.
 */
export type ActionResult<T> =
	| { ok: true; value: T }
	| { ok: false; code: ApiErrorCode; message: string }
