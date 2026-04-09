import { describe, expect, test } from 'bun:test'
import { silentLogger } from '../src/logger'
import { PgHistory } from '../src/PgHistory'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgHistory', () => {
	test('should initialize with tables config', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({
			pool,
			tables: ['users', 'orders'],
		})

		expect(audit).toBeDefined()
	})

	test('should initialize with connection string', () => {
		const audit = new PgHistory({
			connection: 'postgres://localhost:5432/test',
			tables: ['users'],
		})

		expect(audit).toBeDefined()
	})
})

// ─────────────────────────────────────────────────────────
// Review Fix #16: primaryKeyCache invalidation
// ─────────────────────────────────────────────────────────

describe('Review Fix #16: primaryKeyCache invalidation', () => {
	test('invalidatePrimaryKeyCache is exposed and works', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({
			pool,
			tables: ['users'],
			logger: silentLogger,
		})

		expect(typeof audit.invalidatePrimaryKeyCache).toBe('function')
		// Should not throw when called without args
		expect(() => audit.invalidatePrimaryKeyCache()).not.toThrow()
		// Should not throw when called with a specific table
		expect(() => audit.invalidatePrimaryKeyCache('users')).not.toThrow()
	})

	test('invalidateSoftDeleteColumnCache is exposed and works', async () => {
		const pool = await getTestConnection()
		const audit = new PgHistory({
			pool,
			tables: ['users'],
			logger: silentLogger,
		})

		expect(typeof audit.invalidateSoftDeleteColumnCache).toBe('function')
		expect(() => audit.invalidateSoftDeleteColumnCache()).not.toThrow()
	})
})
