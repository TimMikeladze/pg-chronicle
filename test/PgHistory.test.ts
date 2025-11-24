import { describe, expect, test } from 'bun:test'
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
