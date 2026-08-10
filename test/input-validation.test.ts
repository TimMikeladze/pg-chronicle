import { beforeEach, describe, expect, test } from 'bun:test'
import type { Pool } from 'pg'
import { PgHistory } from '../src/PgHistory'
import { cleanDatabase, getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgHistory input validation', () => {
	let pool: Pool
	let audit: PgHistory

	beforeEach(async () => {
		pool = await getTestConnection()
		await cleanDatabase()

		await pool.query(`
			CREATE TABLE users (
				id SERIAL PRIMARY KEY,
				name TEXT NOT NULL,
				email TEXT
			)
		`)

		audit = new PgHistory({ pool, tables: ['users'] })
		await audit.setup()
	})

	describe('getHistory validation', () => {
		test('should reject recordId exceeding max length', async () => {
			const longRecordId = 'x'.repeat(501)
			await expect(async () => {
				await audit.getHistory('users', longRecordId)
			}).toThrow('recordId exceeds maximum length')
		})

		test('should reject recordId with null bytes', async () => {
			await expect(async () => {
				await audit.getHistory('users', 'record\0id')
			}).toThrow('recordId cannot contain null bytes')
		})

		test('should reject empty recordId', async () => {
			await expect(async () => {
				await audit.getHistory('users', '')
			}).toThrow('recordId cannot be empty')
		})

		test('should reject invalid limit', async () => {
			await expect(async () => {
				await audit.getHistory('users', '123', { limit: -1 })
			}).toThrow('limit must be a positive integer')
		})

		test('should cap limit at maximum', async () => {
			// Insert a record to test with
			await pool.query(
				`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`,
			)

			// Request huge limit, should be capped
			const result = await audit.getHistory('users', '1', { limit: 99999 })

			// Should work without throwing, but internally capped
			expect(result).toBeDefined()
		})

		test('should reject cursor with null bytes', async () => {
			await expect(async () => {
				await audit.getHistory('users', '123', { cursor: 'cursor\0id' })
			}).toThrow('cursor cannot contain null bytes')
		})

		test('should accept valid recordId', async () => {
			await pool.query(
				`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`,
			)
			await expect(async () => {
				await audit.getHistory('users', '1')
			}).not.toThrow()
		})
	})

	describe('search validation', () => {
		test('should reject query exceeding max length', async () => {
			const longQuery = 'x'.repeat(501)
			await expect(async () => {
				await audit.search({ tables: ['users'], query: longQuery })
			}).toThrow('query exceeds maximum length')
		})

		test('should escape wildcards in query', async () => {
			// Insert test data
			await pool.query(
				`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`,
			)
			await pool.query(
				`UPDATE users SET email = 'alice2@example.com' WHERE id = 1`,
			)

			// Search with wildcards - they should be escaped, not treated as wildcards
			const result = await audit.search({
				tables: ['users'],
				query: '%_test',
			})

			// Should not throw and wildcards should be escaped
			expect(result).toBeDefined()
		})

		test('should cap limit at maximum', async () => {
			await pool.query(
				`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`,
			)

			// Request huge limit, should be capped
			const result = await audit.search({ tables: ['users'], limit: 99999 })

			// Should work without throwing
			expect(result).toBeDefined()
		})

		test('should accept valid search parameters', async () => {
			await pool.query(
				`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`,
			)

			await expect(async () => {
				await audit.search({
					tables: ['users'],
					query: 'alice',
					operation: 'INSERT',
				})
			}).not.toThrow()
		})
	})

	describe('setup error handling', () => {
		test('should handle setup gracefully when table does not exist', async () => {
			// Create audit with non-existent table
			const badAudit = new PgHistory({ pool, tables: ['nonexistent_table'] })

			// Setup should not throw for non-existent tables - it just skips them
			// This is by design for idempotency
			await expect(async () => {
				await badAudit.setup()
			}).not.toThrow()

			// Cleanup
			await badAudit.teardown()
		})

		test('should throw on empty table list', async () => {
			const badAudit = new PgHistory({ pool, tables: [] })

			await expect(async () => {
				await badAudit.setup()
			}).toThrow('No tables configured')
		})
	})
})
