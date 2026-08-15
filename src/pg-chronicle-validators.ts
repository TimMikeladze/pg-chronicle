/**
 * Validation helpers for PgChronicle inputs.
 *
 * These are pure functions that throw ValidationError (from ./errors) so
 * callers can translate them into 400 responses at API boundaries.
 * Extracted from PgChronicle.ts to keep that file focused on orchestration.
 */
import { ValidationError } from './errors'

// PostgreSQL identifier rules: start with letter/underscore,
// contain only alphanumeric + underscore, max 63 chars.
const IDENTIFIER_REGEX = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/

/**
 * Validates a PostgreSQL identifier (table or column name).
 * Used to prevent SQL injection when we must interpolate identifiers
 * directly into SQL.
 */
export function validateIdentifier(
	name: string,
	kind: 'table' | 'column' | 'schema',
): void {
	if (!IDENTIFIER_REGEX.test(name)) {
		const kindLabel = kind.charAt(0).toUpperCase() + kind.slice(1)
		throw new ValidationError(
			`Invalid ${kind} name: "${name}". ${kindLabel} names must start with a letter or underscore and contain only alphanumeric characters and underscores.`,
		)
	}
}

/**
 * Validates an array of column names.
 */
export function validateColumnNames(names: string[]): void {
	for (const name of names) {
		validateIdentifier(name, 'column')
	}
}

/**
 * Validates a user-provided string input (bounded length, no null bytes).
 * Throws ValidationError so API handlers can return 400.
 */
export function validateStringInput(
	value: unknown,
	fieldName: string,
	maxLength = 1000,
): asserts value is string {
	if (typeof value !== 'string') {
		throw new ValidationError(`${fieldName} must be a string`)
	}
	if (value.length === 0) {
		throw new ValidationError(`${fieldName} cannot be empty`)
	}
	if (value.length > maxLength) {
		throw new ValidationError(
			`${fieldName} exceeds maximum length of ${maxLength} characters`,
		)
	}
	if (value.includes('\0')) {
		throw new ValidationError(`${fieldName} cannot contain null bytes`)
	}
}

/**
 * Validates and caps a pagination limit.
 * Returns the validated limit or the default when `limit` is undefined.
 */
export function validateLimit(
	limit: number | undefined,
	defaultLimit: number,
): number {
	const MAX_LIMIT = 1000
	if (limit === undefined) return defaultLimit
	if (
		typeof limit !== 'number' ||
		!Number.isFinite(limit) ||
		!Number.isInteger(limit) ||
		limit < 1
	) {
		throw new ValidationError('limit must be a positive integer')
	}
	return Math.min(limit, MAX_LIMIT)
}

/**
 * Validates a cursor string — must be a numeric ID.
 */
export function validateCursor(cursor: string | undefined): void {
	if (cursor === undefined) return
	validateStringInput(cursor, 'cursor', 100)
	if (!/^\d+$/.test(cursor)) {
		throw new ValidationError('cursor must be a numeric ID')
	}
}
