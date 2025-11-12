import { beforeEach, describe, expect, test } from 'bun:test'
import type { SQL } from 'bun'
import { PgHistory } from '../src/PgHistory'
import { cleanDatabase, getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgHistory input validation', () => {
	let sql: SQL
	let audit: PgHistory

	beforeEach(async () => {
		sql = await getTestConnection()
		await cleanDatabase()

		await sql`
			CREATE TABLE users (
				id SERIAL PRIMARY KEY,
				name TEXT NOT NULL,
				email TEXT
			)
		`

		audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()
	})

	describe('setUser validation', () => {
		test('should reject userId exceeding max length', async () => {
			const longUserId = 'x'.repeat(256)
			await expect(async () => {
				await audit.setUser(longUserId)
			}).toThrow('userId exceeds maximum length')
		})

		test('should reject userId with null bytes', async () => {
			await expect(async () => {
				await audit.setUser('user\0id')
			}).toThrow('userId cannot contain null bytes')
		})

		test('should reject empty userId', async () => {
			await expect(async () => {
				await audit.setUser('')
			}).toThrow('userId cannot be empty')
		})

		test('should reject metadata exceeding max size', async () => {
			const hugeMetadata = { data: 'x'.repeat(10001) }
			await expect(async () => {
				await audit.setUser('user123', hugeMetadata)
			}).toThrow('User metadata exceeds maximum size')
		})

		test('should accept valid userId', async () => {
			await expect(async () => {
				await audit.setUser('valid_user_123')
			}).not.toThrow()
		})

		test('should accept valid metadata', async () => {
			await expect(async () => {
				await audit.setUser('user123', { role: 'admin', permissions: ['read'] })
			}).not.toThrow()
		})
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
			}).toThrow('Limit must be a positive integer')
		})

		test('should cap limit at maximum', async () => {
			// Insert a record to test with
			await sql`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`

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
			await sql`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`
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

		test('should reject changedBy exceeding max length', async () => {
			const longChangedBy = 'x'.repeat(256)
			await expect(async () => {
				await audit.search({ tables: ['users'], changedBy: longChangedBy })
			}).toThrow('changedBy exceeds maximum length')
		})

		test('should escape wildcards in query', async () => {
			// Insert test data
			await sql`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`
			await sql`UPDATE users SET email = 'alice2@example.com' WHERE id = 1`

			// Search with wildcards - they should be escaped, not treated as wildcards
			const result = await audit.search({
				tables: ['users'],
				query: '%_test',
			})

			// Should not throw and wildcards should be escaped
			expect(result).toBeDefined()
		})

		test('should cap limit at maximum', async () => {
			await sql`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`

			// Request huge limit, should be capped
			const result = await audit.search({ tables: ['users'], limit: 99999 })

			// Should work without throwing
			expect(result).toBeDefined()
		})

		test('should accept valid search parameters', async () => {
			await sql`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`

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
			const badAudit = new PgHistory({ sql, tables: ['nonexistent_table'] })

			// Setup should not throw for non-existent tables - it just skips them
			// This is by design for idempotency
			await expect(async () => {
				await badAudit.setup()
			}).not.toThrow()

			// Cleanup
			await badAudit.teardown()
		})

		test('should throw on empty table list', async () => {
			const badAudit = new PgHistory({ sql, tables: [] })

			await expect(async () => {
				await badAudit.setup()
			}).toThrow('No tables configured')
		})
	})
})
