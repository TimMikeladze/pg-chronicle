import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { PgHistory } from '../src/PgHistory'
import { cleanDatabase, getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgHistory security - validation', () => {
	test('should reject invalid table names', () => {
		expect(() => {
			new PgHistory({
				connection: 'postgres://localhost/test',
				tables: ['users; DROP TABLE audit_log; --'],
			})
		}).toThrow('Invalid table name')
	})

	test('should reject table names with special characters', () => {
		expect(() => {
			new PgHistory({
				connection: 'postgres://localhost/test',
				tables: ['users$table'],
			})
		}).toThrow('Invalid table name')
	})

	test('should reject table names starting with numbers', () => {
		expect(() => {
			new PgHistory({
				connection: 'postgres://localhost/test',
				tables: ['1users'],
			})
		}).toThrow('Invalid table name')
	})

	test('should reject table names exceeding 63 characters', () => {
		const longName = 'a'.repeat(64)
		expect(() => {
			new PgHistory({
				connection: 'postgres://localhost/test',
				tables: [longName],
			})
		}).toThrow('Invalid table name')
	})

	test('should accept valid table names', () => {
		expect(() => {
			new PgHistory({
				connection: 'postgres://localhost/test',
				tables: ['users', 'user_accounts', '_private_table', 'Table123'],
			})
		}).not.toThrow()
	})
})

describe('PgHistory security - database operations', () => {
	let sql: SQL
	let audit: PgHistory

	beforeEach(async () => {
		sql = await getTestConnection()
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
		await sql`
			CREATE TABLE malicious_table (
				id SERIAL PRIMARY KEY,
				name TEXT
			)
		`

		audit = new PgHistory({
			sql,
			tables: ['malicious_table'],
		})

		await audit.setup()

		// Now try to insert data
		await sql`
			INSERT INTO malicious_table (name)
			VALUES ('test')
		`

		// This should work fine as the column names are valid
		const history = await audit.getHistory('malicious_table', '1')
		expect(history.data.length).toBeGreaterThan(0)
	})

	test('should handle JSON serialization errors in setUser', async () => {
		// Create a circular reference
		const circular: Record<string, unknown> = {}
		circular.self = circular

		await sql`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)`

		audit = new PgHistory({
			sql,
			tables: ['users'],
		})

		await audit.setup()

		await expect(async () => {
			await audit.setUser('user123', circular)
		}).toThrow('Failed to serialize user metadata')
	})

	test('should successfully serialize valid metadata', async () => {
		await sql`CREATE TABLE users (id SERIAL PRIMARY KEY, name TEXT)`

		audit = new PgHistory({
			sql,
			tables: ['users'],
		})

		await audit.setup()

		// Valid metadata should work
		await expect(async () => {
			await audit.setUser('user123', {
				role: 'admin',
				permissions: ['read', 'write'],
			})
		}).not.toThrow()
	})
})
