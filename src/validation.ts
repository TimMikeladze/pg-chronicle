/**
 * Runtime input validation for server API endpoints.
 *
 * These helpers validate untrusted JSON bodies at the boundary, so
 * downstream code can rely on well-formed inputs. Each function throws
 * ValidationError with a specific message that API handlers translate
 * into a 400 response.
 */
import { ValidationError } from './errors'
import { validateCursor, validateIdentifier } from './pg-history-validators'
import type { AuditOperation, SearchCursor, SearchOptions } from './types'

// TRUNCATE included: the statement-level trigger writes a marker row for every
// bulk wipe, so it must be selectable like any other operation.
const VALID_OPERATIONS = new Set<AuditOperation>([
	'INSERT',
	'UPDATE',
	'DELETE',
	'TRUNCATE',
])

/**
 * Parse and validate the body of POST /api/history/search.
 * Returns a well-typed SearchOptions or throws ValidationError.
 */
export function parseSearchBody(body: unknown): SearchOptions {
	if (!isPlainObject(body)) {
		throw new ValidationError('request body must be a JSON object')
	}

	// tables — required, non-empty array of strings
	if (!Array.isArray(body.tables) || body.tables.length === 0) {
		throw new ValidationError(
			'tables is required and must be a non-empty array of strings',
		)
	}
	if (!body.tables.every((t) => typeof t === 'string' && t.length > 0)) {
		throw new ValidationError('tables must contain only non-empty strings')
	}
	// Validate each name as a safe identifier at the API boundary.
	// This is NOT a breaking change: PgHistory already enforces the same
	// identifier regex on all configured table names at construction time, so
	// any name that passes the downstream allowlist check will also pass here.
	// The only practical effect is that injection strings like "users;DROP TABLE"
	// now get a 400 ValidationError instead of a 400 INVALID_TABLE — better DX
	// and removes the table-existence probing oracle.
	for (const t of body.tables as string[]) {
		validateIdentifier(t, 'table')
	}

	// query — optional string
	if (body.query !== undefined && typeof body.query !== 'string') {
		throw new ValidationError('query must be a string')
	}

	// operation — optional, one of INSERT/UPDATE/DELETE/TRUNCATE
	if (body.operation !== undefined) {
		if (
			typeof body.operation !== 'string' ||
			!VALID_OPERATIONS.has(body.operation as AuditOperation)
		) {
			throw new ValidationError(
				'operation must be one of: INSERT, UPDATE, DELETE, TRUNCATE',
			)
		}
	}

	// dateFrom / dateTo — optional ISO-8601 strings, must parse to a valid Date
	const dateFrom = parseOptionalDate(body.dateFrom, 'dateFrom')
	const dateTo = parseOptionalDate(body.dateTo, 'dateTo')
	if (dateFrom && dateTo && dateFrom > dateTo) {
		throw new ValidationError('dateFrom must be <= dateTo')
	}

	// limit — optional positive integer
	let limit: number | undefined
	if (body.limit !== undefined) {
		if (
			typeof body.limit !== 'number' ||
			!Number.isFinite(body.limit) ||
			!Number.isInteger(body.limit) ||
			body.limit < 1
		) {
			throw new ValidationError('limit must be a positive integer')
		}
		limit = body.limit
	}

	// cursor — optional numeric string; validate format at the boundary
	// (search() also calls validateCursor, but validating here gives the caller
	// a 400 before any database interaction).
	let cursor: SearchCursor | undefined
	if (body.cursor !== undefined) {
		if (typeof body.cursor !== 'string') {
			throw new ValidationError('cursor must be a string')
		}
		validateCursor(body.cursor)
		// Safe cast: validateCursor confirms this is a numeric string, which is
		// the only valid SearchCursor value produced by search().
		cursor = body.cursor as SearchCursor
	}

	return {
		tables: body.tables as string[],
		query: body.query as string | undefined,
		operation: body.operation as AuditOperation | undefined,
		dateFrom,
		dateTo,
		limit,
		cursor,
	}
}

/**
 * Parse and validate the body of POST /api/history/revert.
 */
export function parseRevertBody(body: unknown): {
	table: string
	recordId: string
	auditEntryId: string
	suppressAuditTriggers?: boolean
} {
	if (!isPlainObject(body)) {
		throw new ValidationError('request body must be a JSON object')
	}

	const { table, recordId, auditEntryId, suppressAuditTriggers } =
		body as Record<string, unknown>

	if (typeof table !== 'string' || table.length === 0) {
		throw new ValidationError(
			'table is required and must be a non-empty string',
		)
	}
	validateIdentifier(table, 'table')
	if (typeof recordId !== 'string' || recordId.length === 0) {
		throw new ValidationError(
			'recordId is required and must be a non-empty string',
		)
	}
	if (recordId.length > 512) {
		throw new ValidationError('recordId must not exceed 512 characters')
	}
	if (recordId.includes('\0')) {
		throw new ValidationError('recordId cannot contain null bytes')
	}
	if (typeof auditEntryId !== 'string' || auditEntryId.length === 0) {
		throw new ValidationError(
			'auditEntryId is required and must be a non-empty string',
		)
	}
	if (auditEntryId.length > 100) {
		throw new ValidationError('auditEntryId must not exceed 100 characters')
	}
	// auditEntryId is an audit_log id (bigint). Validate numeric here so a
	// malformed value returns 400, not a 500 from the `$1::bigint` cast downstream.
	if (!/^\d+$/.test(auditEntryId)) {
		throw new ValidationError('auditEntryId must be a numeric id')
	}

	// Optional: opt into suppressing the revert's own audit entries. Requires the
	// pg_replication role / SUPERUSER on the DB (see PgHistory.revert). Default
	// (undefined → false) records the revert, which works on least-privilege roles.
	if (
		suppressAuditTriggers !== undefined &&
		typeof suppressAuditTriggers !== 'boolean'
	) {
		throw new ValidationError('suppressAuditTriggers must be a boolean')
	}

	return {
		table,
		recordId,
		auditEntryId,
		suppressAuditTriggers: suppressAuditTriggers as boolean | undefined,
	}
}

function parseOptionalDate(
	value: unknown,
	fieldName: string,
): Date | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'string') {
		throw new ValidationError(`${fieldName} must be an ISO-8601 string`)
	}
	const date = new Date(value)
	if (Number.isNaN(date.getTime())) {
		throw new ValidationError(`${fieldName} is not a valid date`)
	}
	return date
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
