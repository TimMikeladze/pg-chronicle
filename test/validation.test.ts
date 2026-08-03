import { describe, expect, test } from 'bun:test'
import { PgHistory } from '../src'
import { PgHistoryError, RevertError, ValidationError } from '../src/errors'
import {
	validateColumnNames,
	validateCursor,
	validateIdentifier,
	validateLimit,
	validateStringInput,
} from '../src/pghistory-validators'
import { parseRevertBody, parseSearchBody } from '../src/validation'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgHistory validation', () => {
	test('should throw if no tables configured', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: [] })

		await expect(async () => {
			await audit.setup()
		}).toThrow('No tables configured')
	})

	test('should throw if querying unconfigured table', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		await expect(async () => {
			await audit.getHistory('orders', '1')
		}).toThrow('not configured for history tracking')
	})

	test('should throw if searching unconfigured table', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()

		await expect(async () => {
			await audit.search({ tables: ['orders'] })
		}).toThrow('not configured for history tracking')
	})
})

// ─────────────────────────────────────────────────────────
// parseSearchBody — runtime validation for POST /api/history/search
// ─────────────────────────────────────────────────────────

describe('parseSearchBody runtime validation', () => {
	test('rejects non-object body', () => {
		expect(() => parseSearchBody(null)).toThrow(ValidationError)
		expect(() => parseSearchBody('string')).toThrow(ValidationError)
		expect(() => parseSearchBody([1, 2])).toThrow(ValidationError)
	})

	test('rejects missing tables', () => {
		expect(() => parseSearchBody({})).toThrow('tables is required')
		expect(() => parseSearchBody({ tables: [] })).toThrow('tables is required')
	})

	test('rejects non-string table entries', () => {
		expect(() => parseSearchBody({ tables: [1, 2] })).toThrow(
			'tables must contain only non-empty strings',
		)
		expect(() => parseSearchBody({ tables: ['', 'users'] })).toThrow(
			'tables must contain only non-empty strings',
		)
	})

	test('rejects invalid operation value', () => {
		expect(() =>
			parseSearchBody({ tables: ['users'], operation: 'DROP' }),
		).toThrow('operation must be one of')
	})

	test('rejects invalid dateFrom/dateTo', () => {
		expect(() =>
			parseSearchBody({ tables: ['users'], dateFrom: 'not a date' }),
		).toThrow('dateFrom is not a valid date')
		expect(() =>
			parseSearchBody({ tables: ['users'], dateTo: 'not a date' }),
		).toThrow('dateTo is not a valid date')
	})

	test('rejects dateFrom > dateTo', () => {
		expect(() =>
			parseSearchBody({
				tables: ['users'],
				dateFrom: '2025-06-01',
				dateTo: '2025-05-01',
			}),
		).toThrow('dateFrom must be <= dateTo')
	})

	test('rejects non-positive limit', () => {
		expect(() => parseSearchBody({ tables: ['users'], limit: 0 })).toThrow(
			'limit must be a positive integer',
		)
		expect(() => parseSearchBody({ tables: ['users'], limit: -5 })).toThrow(
			'limit must be a positive integer',
		)
		expect(() => parseSearchBody({ tables: ['users'], limit: 1.5 })).toThrow(
			'limit must be a positive integer',
		)
		expect(() =>
			parseSearchBody({ tables: ['users'], limit: Number.POSITIVE_INFINITY }),
		).toThrow('limit must be a positive integer')
	})

	test('rejects non-numeric cursor', () => {
		expect(() => parseSearchBody({ tables: ['users'], cursor: 'abc' })).toThrow(
			'cursor must be a numeric ID',
		)
	})

	test('accepts fully-valid body', () => {
		const result = parseSearchBody({
			tables: ['users', 'orders'],
			query: 'hello',
			operation: 'INSERT',
			dateFrom: '2025-01-01',
			dateTo: '2025-12-31',
			limit: 50,
			cursor: '100',
		})
		expect(result.tables).toEqual(['users', 'orders'])
		expect(result.operation).toBe('INSERT')
		expect(result.dateFrom).toBeInstanceOf(Date)
		expect(result.dateTo).toBeInstanceOf(Date)
		expect(result.limit).toBe(50)
		expect(result.cursor as string).toBe('100')
	})
})

// ─────────────────────────────────────────────────────────
// parseRevertBody — runtime validation for POST /api/history/revert
// ─────────────────────────────────────────────────────────

describe('parseRevertBody runtime validation', () => {
	test('rejects missing fields', () => {
		expect(() => parseRevertBody({})).toThrow(/required/)
		expect(() => parseRevertBody({ table: 'users' })).toThrow(/required/)
		expect(() => parseRevertBody({ table: 'users', recordId: '1' })).toThrow(
			/required/,
		)
	})

	test('rejects non-object body', () => {
		expect(() => parseRevertBody(null)).toThrow(ValidationError)
		expect(() => parseRevertBody([])).toThrow(ValidationError)
	})

	test('accepts a well-formed body', () => {
		const result = parseRevertBody({
			table: 'users',
			recordId: 'u-1',
			auditEntryId: '42',
		})
		expect(result).toEqual({
			table: 'users',
			recordId: 'u-1',
			auditEntryId: '42',
		})
	})
})

// ─────────────────────────────────────────────────────────
// Error class hierarchy
// ─────────────────────────────────────────────────────────

describe('PgHistory error class hierarchy', () => {
	test('ValidationError is a PgHistoryError', () => {
		const err = new ValidationError('bad input')
		expect(err).toBeInstanceOf(PgHistoryError)
		expect(err.name).toBe('ValidationError')
	})

	test('RevertError is a PgHistoryError', () => {
		const err = new RevertError('cannot revert')
		expect(err).toBeInstanceOf(PgHistoryError)
		expect(err.name).toBe('RevertError')
	})
})

// ─────────────────────────────────────────────────────────
// pghistory-validators — extracted pure validation functions
// ─────────────────────────────────────────────────────────

describe('pghistory-validators — extracted validation functions', () => {
	test('validateIdentifier rejects invalid table names', () => {
		expect(() => validateIdentifier('valid_name', 'table')).not.toThrow()
		expect(() =>
			validateIdentifier('_leading_underscore', 'table'),
		).not.toThrow()
		expect(() => validateIdentifier('1starts_with_digit', 'table')).toThrow(
			/Invalid table/,
		)
		expect(() => validateIdentifier('has-dash', 'table')).toThrow(
			/Invalid table/,
		)
		expect(() => validateIdentifier('', 'table')).toThrow(/Invalid table/)
		// PG identifier max is 63 chars
		expect(() => validateIdentifier('a'.repeat(64), 'table')).toThrow(
			/Invalid table/,
		)
	})

	test('validateIdentifier rejects invalid column names', () => {
		expect(() => validateIdentifier('id', 'column')).not.toThrow()
		expect(() => validateIdentifier('user_id', 'column')).not.toThrow()
		expect(() => validateIdentifier('bad col', 'column')).toThrow(
			/Invalid column/,
		)
	})

	test('validateColumnNames validates an array', () => {
		expect(() => validateColumnNames(['id', 'name'])).not.toThrow()
		expect(() => validateColumnNames(['id', 'bad name'])).toThrow()
	})

	test('validateStringInput asserts type narrowing', () => {
		expect(() => validateStringInput('hello', 'field')).not.toThrow()
		expect(() => validateStringInput('', 'field')).toThrow(ValidationError)
		expect(() => validateStringInput('  ', 'field')).not.toThrow()
		expect(() => validateStringInput(123, 'field')).toThrow(ValidationError)
		expect(() => validateStringInput(null, 'field')).toThrow(ValidationError)
		expect(() => validateStringInput('a'.repeat(2000), 'field', 100)).toThrow(
			/exceeds maximum length of 100/,
		)
		expect(() => validateStringInput('has\0null', 'field')).toThrow(
			/cannot contain null bytes/,
		)
	})

	test('validateLimit returns default when undefined', () => {
		expect(validateLimit(undefined, 50)).toBe(50)
	})

	test('validateLimit caps at 1000', () => {
		expect(validateLimit(500, 50)).toBe(500)
		expect(validateLimit(1_000_000, 50)).toBe(1000)
	})

	test('validateLimit rejects invalid values', () => {
		expect(() => validateLimit(0, 50)).toThrow(ValidationError)
		expect(() => validateLimit(-1, 50)).toThrow(ValidationError)
		expect(() => validateLimit(1.5, 50)).toThrow(ValidationError)
		expect(() => validateLimit(Number.NaN, 50)).toThrow(ValidationError)
		expect(() => validateLimit(Number.POSITIVE_INFINITY, 50)).toThrow(
			ValidationError,
		)
	})

	test('validateCursor accepts numeric strings', () => {
		expect(() => validateCursor(undefined)).not.toThrow()
		expect(() => validateCursor('123')).not.toThrow()
		expect(() => validateCursor('9223372036854775807')).not.toThrow()
	})

	test('validateCursor rejects non-numeric strings', () => {
		expect(() => validateCursor('abc')).toThrow(/numeric ID/)
		expect(() => validateCursor('12.5')).toThrow(/numeric ID/)
		expect(() => validateCursor('-1')).toThrow(/numeric ID/)
	})
})
