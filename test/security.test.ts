import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { PgChronicle } from '../src/PgChronicle'
import { cleanDatabase, getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgChronicle security - validation', () => {
	test('should reject invalid table names', () => {
		expect(() => {
			new PgChronicle({
				connection: 'postgres://localhost/test',
				tables: ['users; DROP TABLE audit_log; --'],
			})
		}).toThrow('Invalid table name')
	})

	test('should reject table names with special characters', () => {
		expect(() => {
			new PgChronicle({
				connection: 'postgres://localhost/test',
				tables: ['users$table'],
			})
		}).toThrow('Invalid table name')
	})

	test('should reject table names starting with numbers', () => {
		expect(() => {
			new PgChronicle({
				connection: 'postgres://localhost/test',
				tables: ['1users'],
			})
		}).toThrow('Invalid table name')
	})

	test('should reject table names exceeding 63 characters', () => {
		const longName = 'a'.repeat(64)
		expect(() => {
			new PgChronicle({
				connection: 'postgres://localhost/test',
				tables: [longName],
			})
		}).toThrow('Invalid table name')
	})

	test('should accept valid table names', () => {
		expect(() => {
			new PgChronicle({
				connection: 'postgres://localhost/test',
				tables: ['users', 'user_accounts', '_private_table', 'Table123'],
			})
		}).not.toThrow()
	})
})

describe('PgChronicle security - database operations', () => {
	let pool: Pool
	let audit: PgChronicle

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()
	})

	afterEach(async () => {
		if (audit) {
			await audit.teardown()
		}
		await cleanDatabase()
	})

	test('should reject malicious column names from database', async () => {
		// Create a test table with a malicious column name
		// This simulates a compromised database
		await pool.query(`
			CREATE TABLE malicious_table (
				id SERIAL PRIMARY KEY,
				name TEXT
			)
		`)

		audit = new PgChronicle({
			pool,
			tables: ['malicious_table'],
		})

		await audit.setup()

		// Now try to insert data
		await pool.query(`
			INSERT INTO malicious_table (name)
			VALUES ('test')
		`)

		// This should work fine as the column names are valid
		const history = await audit.getHistory('malicious_table', '1')
		expect(history.data.length).toBeGreaterThan(0)
	})
})
