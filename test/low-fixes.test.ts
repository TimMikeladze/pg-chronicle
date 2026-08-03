import { beforeEach, describe, expect, test } from 'bun:test'
import { PgHistory } from '../src'
import { buildTriggerFunctionSql } from '../src/pg-history-triggers'
import { parseRevertBody } from '../src/validation'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('L5: composite-PK record_id is not truncated (no collision)', () => {
	test('trigger joins full untruncated PK components with chr(31)', () => {
		const sql = buildTriggerFunctionSql({
			schema: 'public',
			funcName: 'audit_trigger_func_user_roles',
			pkColumns: ['user_id', 'role_id'],
			auditTable: '"public"."audit_log"',
		})
		// No LEFT(...,200) truncation — full values are used so distinct keys
		// cannot collide onto one record_id.
		expect(sql).not.toContain('LEFT(')
		expect(sql).toContain('|| chr(31) ||')
		expect(sql).toContain(`COALESCE(NEW."user_id"::text, '')`)
	})
})

describe('L10: auditEntryId must be numeric', () => {
	test('rejects non-numeric auditEntryId with a validation error', () => {
		expect(() =>
			parseRevertBody({ table: 'users', recordId: '1', auditEntryId: 'abc' }),
		).toThrow(/numeric/)
	})

	test('accepts a numeric auditEntryId', () => {
		expect(
			parseRevertBody({ table: 'users', recordId: '1', auditEntryId: '123' }),
		).toMatchObject({ table: 'users', recordId: '1', auditEntryId: '123' })
	})
})

describe('L7: close() is idempotent', () => {
	beforeEach(async () => {
		const pool = await getTestConnection()
		await pool.query(`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)`)
	})

	test('a second close() on an owned connection does not throw', async () => {
		const pool = await getTestConnection()
		const connectionString = (
			pool as unknown as { options: { connectionString: string } }
		).options.connectionString

		// Own-connection instance so close() actually ends a pool it created.
		const audit = new PgHistory({
			connection: connectionString,
			tables: ['users'],
		})
		await audit.setup()

		await audit.close()
		// Without the idempotency guard this second call rejects with
		// "Called end on pool more than once".
		await expect(audit.close()).resolves.toBeUndefined()
	})
})
