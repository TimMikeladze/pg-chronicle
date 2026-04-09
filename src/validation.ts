/**
 * Runtime input validation for server API endpoints.
 *
 * These helpers validate untrusted JSON bodies at the boundary, so
 * downstream code can rely on well-formed inputs. Each function throws
 * ValidationError with a specific message that API handlers translate
 * into a 400 response.
 */
import { ValidationError } from './errors'
import type { SearchOptions } from './types'

const VALID_OPERATIONS = new Set(['INSERT', 'UPDATE', 'DELETE'])

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

	// query — optional string
	if (body.query !== undefined && typeof body.query !== 'string') {
		throw new ValidationError('query must be a string')
	}

	// operation — optional, one of INSERT/UPDATE/DELETE
	if (body.operation !== undefined) {
		if (
			typeof body.operation !== 'string' ||
			!VALID_OPERATIONS.has(body.operation)
		) {
			throw new ValidationError(
				'operation must be one of: INSERT, UPDATE, DELETE',
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

	// cursor — optional numeric string
	let cursor: string | undefined
	if (body.cursor !== undefined) {
		if (typeof body.cursor !== 'string') {
			throw new ValidationError('cursor must be a string')
		}
		if (!/^\d+$/.test(body.cursor)) {
			throw new ValidationError('cursor must be a numeric ID')
		}
		cursor = body.cursor
	}

	return {
		tables: body.tables as string[],
		query: body.query as string | undefined,
		operation: body.operation as 'INSERT' | 'UPDATE' | 'DELETE' | undefined,
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
} {
	if (!isPlainObject(body)) {
		throw new ValidationError('request body must be a JSON object')
	}

	const { table, recordId, auditEntryId } = body as Record<string, unknown>

	if (typeof table !== 'string' || table.length === 0) {
		throw new ValidationError(
			'table is required and must be a non-empty string',
		)
	}
	if (typeof recordId !== 'string' || recordId.length === 0) {
		throw new ValidationError(
			'recordId is required and must be a non-empty string',
		)
	}
	if (typeof auditEntryId !== 'string' || auditEntryId.length === 0) {
		throw new ValidationError(
			'auditEntryId is required and must be a non-empty string',
		)
	}

	return { table, recordId, auditEntryId }
}

function parseOptionalDate(
	value: unknown,
	fieldName: string,
): Date | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'string' && !(value instanceof Date)) {
		throw new ValidationError(`${fieldName} must be an ISO-8601 string or Date`)
	}
	const date = value instanceof Date ? value : new Date(value)
	if (Number.isNaN(date.getTime())) {
		throw new ValidationError(`${fieldName} is not a valid date`)
	}
	return date
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
