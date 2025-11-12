import { describe, expect, test } from 'bun:test'
import { PgHistory } from '../src'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgHistory validation', () => {
	test('should throw if no tables configured', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: [] })

		await expect(async () => {
			await audit.setup()
		}).toThrow('No tables configured')
	})

	test('should throw if querying unconfigured table', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		await expect(async () => {
			await audit.getHistory('orders', '1')
		}).toThrow('not configured for history tracking')
	})

	test('should throw if searching unconfigured table', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		await expect(async () => {
			await audit.search({ tables: ['orders'] })
		}).toThrow('not configured for history tracking')
	})
})
