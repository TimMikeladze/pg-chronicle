import { describe, expect, test } from 'bun:test'
import { PgHistory } from '../src/PgHistory'
import { createServer } from '../src/server'
import type { AuditEntry } from '../src/types'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('Read-Only API Integration Test', () => {
	test('should handle complete read-only workflow: setup, insert/update data, retrieve history, search across tables', async () => {
		const pool = await getTestConnection()

		// Step 1: Set up test database and tables
		console.log('Step 1: Creating test tables...')
		await pool.query(`
			CREATE TABLE IF NOT EXISTS users (
				id SERIAL PRIMARY KEY,
				name TEXT,
				email TEXT
			)
		`)

		await pool.query(`
			CREATE TABLE IF NOT EXISTS posts (
				id SERIAL PRIMARY KEY,
				title TEXT,
				content TEXT,
				user_id INTEGER REFERENCES users(id)
			)
		`)

		// Step 2: Initialize PgHistory and set up triggers
		console.log('Step 2: Setting up PgHistory triggers...')
		const pgHistory = new PgHistory({
			tables: ['users', 'posts'],
			pool,
		})
		await pgHistory.setup()

		// Step 3: Create test data (INSERT and UPDATE operations)
		console.log('Step 3: Creating test data...')

		// Insert users
		await pool.query(
			`INSERT INTO users (id, name, email) VALUES (1, 'Alice', 'alice@example.com')`,
		)
		await pool.query(
			`INSERT INTO users (id, name, email) VALUES (2, 'Bob', 'bob@example.com')`,
		)

		// Update user to create history
		await pool.query(`UPDATE users SET name = 'Alice Smith' WHERE id = 1`)
		await pool.query(
			`UPDATE users SET email = 'alice.smith@example.com' WHERE id = 1`,
		)

		// Insert posts
		await pool.query(
			`INSERT INTO posts (id, title, content, user_id) VALUES (1, 'First Post', 'Hello World', 1)`,
		)
		await pool.query(
			`INSERT INTO posts (id, title, content, user_id) VALUES (2, 'Second Post', 'Testing', 2)`,
		)

		// Update post
		await pool.query(
			`UPDATE posts SET title = 'Updated First Post' WHERE id = 1`,
		)

		// Step 4: Create server instance
		console.log('Step 4: Creating server...')
		const { app } = await createServer({
			pool,
			port: 3001,
			enableHistory: true,
			historyConfig: {
				tables: ['users', 'posts'],
			},
		})

		// Step 5: Test GET /api/history/:table/:recordId
		console.log('Step 5: Testing GET /api/history/:table/:recordId...')

		const usersHistoryRes = await app.request('/api/history/users/1')
		expect(usersHistoryRes.status).toBe(200)

		const usersHistory = await usersHistoryRes.json()
		expect(usersHistory.data).toBeArray()
		expect(usersHistory.data.length).toBeGreaterThanOrEqual(3) // INSERT + 2 UPDATEs
		expect(usersHistory).toHaveProperty('nextCursor')
		expect(usersHistory).toHaveProperty('hasMore')

		// Verify history contains expected operations
		const operations = usersHistory.data.map(
			(entry: AuditEntry) => entry.operation,
		)
		expect(operations).toContain('INSERT')
		expect(operations).toContain('UPDATE')

		// Verify data content
		const insertEntry = usersHistory.data.find(
			(entry: AuditEntry) => entry.operation === 'INSERT',
		)
		expect(insertEntry).toBeDefined()
		expect(insertEntry?.newData?.name).toBe('Alice')
		expect(insertEntry?.newData?.email).toBe('alice@example.com')

		const updateEntries = usersHistory.data.filter(
			(entry: AuditEntry) => entry.operation === 'UPDATE',
		)
		expect(updateEntries.length).toBe(2)

		// Test posts history
		const postsHistoryRes = await app.request('/api/history/posts/1')
		expect(postsHistoryRes.status).toBe(200)

		const postsHistory = await postsHistoryRes.json()
		expect(postsHistory.data).toBeArray()
		expect(postsHistory.data.length).toBeGreaterThanOrEqual(2) // INSERT + UPDATE

		// Step 6: Test POST /api/history/search across tables
		console.log('Step 6: Testing POST /api/history/search...')

		// Search for all INSERT operations across both tables
		const searchInsertRes = await app.request('/api/history/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tables: ['users', 'posts'],
				operation: 'INSERT',
			}),
		})

		expect(searchInsertRes.status).toBe(200)
		const searchInsertData = await searchInsertRes.json()
		expect(searchInsertData.data).toBeArray()
		expect(searchInsertData.data.length).toBe(4) // 2 users + 2 posts

		// Verify all are INSERT operations
		for (const entry of searchInsertData.data) {
			expect(entry.operation).toBe('INSERT')
		}

		// Search for all UPDATE operations
		const searchUpdateRes = await app.request('/api/history/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tables: ['users', 'posts'],
				operation: 'UPDATE',
			}),
		})

		expect(searchUpdateRes.status).toBe(200)
		const searchUpdateData = await searchUpdateRes.json()
		expect(searchUpdateData.data).toBeArray()
		expect(searchUpdateData.data.length).toBe(3) // 2 user updates + 1 post update

		// Search for specific table
		const searchUsersOnlyRes = await app.request('/api/history/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tables: ['users'],
			}),
		})

		expect(searchUsersOnlyRes.status).toBe(200)
		const searchUsersOnlyData = await searchUsersOnlyRes.json()
		expect(searchUsersOnlyData.data).toBeArray()
		expect(searchUsersOnlyData.data.length).toBe(4) // 2 inserts + 2 updates

		// Verify all entries are from users table
		for (const entry of searchUsersOnlyData.data) {
			expect(entry.tableName).toBe('users')
		}

		// Step 7: Verify query parameters work correctly
		console.log('Step 7: Testing query parameters...')

		// Test with limit
		const limitedHistoryRes = await app.request('/api/history/users/1?limit=2')
		expect(limitedHistoryRes.status).toBe(200)
		const limitedHistory = await limitedHistoryRes.json()
		expect(limitedHistory.data.length).toBeLessThanOrEqual(2)

		// Test with order ascending
		const ascHistoryRes = await app.request('/api/history/users/1?order=asc')
		expect(ascHistoryRes.status).toBe(200)
		const ascHistory = await ascHistoryRes.json()
		expect(ascHistory.data).toBeArray()
		// First entry should be INSERT when ordered ascending
		expect(ascHistory.data[0].operation).toBe('INSERT')

		// Step 8: Test error handling
		console.log('Step 8: Testing error handling...')

		// Test invalid table name
		const invalidTableRes = await app.request('/api/history/invalid_table/1')
		expect(invalidTableRes.status).toBe(400)
		const invalidTableError = await invalidTableRes.json()
		expect(invalidTableError.error.code).toBe('INVALID_TABLE')

		// Test empty tables array in search
		const emptyTablesRes = await app.request('/api/history/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tables: [],
			}),
		})
		expect(emptyTablesRes.status).toBe(400)
		const emptyTablesError = await emptyTablesRes.json()
		expect(emptyTablesError.error.code).toBe('VALIDATION_ERROR')

		// Step 9: Verify complete audit trail integrity
		console.log('Step 9: Verifying audit trail integrity...')

		// Get all history for user 1 and verify chronological order
		const fullHistoryRes = await app.request('/api/history/users/1?order=asc')
		const fullHistory = await fullHistoryRes.json()

		// Should have: INSERT, UPDATE (name), UPDATE (email)
		expect(fullHistory.data.length).toBeGreaterThanOrEqual(3)

		// Verify INSERT comes first
		expect(fullHistory.data[0].operation).toBe('INSERT')
		expect(fullHistory.data[0].oldData).toBeNull()
		expect(fullHistory.data[0].newData.name).toBe('Alice')

		// Verify UPDATEs have proper old/new data
		const nameUpdate = fullHistory.data.find(
			(entry: AuditEntry) =>
				entry.operation === 'UPDATE' &&
				(entry.newData as Record<string, unknown>)?.name === 'Alice Smith',
		)
		expect(nameUpdate).toBeDefined()
		expect((nameUpdate?.oldData as Record<string, unknown>)?.name).toBe('Alice')
		expect((nameUpdate?.newData as Record<string, unknown>)?.name).toBe(
			'Alice Smith',
		)

		const emailUpdate = fullHistory.data.find(
			(entry: AuditEntry) =>
				entry.operation === 'UPDATE' &&
				(entry.newData as Record<string, unknown>)?.email ===
					'alice.smith@example.com',
		)
		expect(emailUpdate).toBeDefined()
		expect((emailUpdate?.oldData as Record<string, unknown>)?.email).toBe(
			'alice@example.com',
		)
		expect((emailUpdate?.newData as Record<string, unknown>)?.email).toBe(
			'alice.smith@example.com',
		)

		// Step 10: Cleanup
		console.log('Step 10: Cleaning up...')
		await pgHistory.teardown()

		console.log('✓ All read-only integration tests passed!')
	})

	test('should handle pagination correctly', async () => {
		const pool = await getTestConnection()

		// Create table
		await pool.query(`
			CREATE TABLE IF NOT EXISTS products (
				id SERIAL PRIMARY KEY,
				name TEXT,
				price DECIMAL
			)
		`)

		// Setup PgHistory
		const pgHistory = new PgHistory({
			tables: ['products'],
			pool,
		})
		await pgHistory.setup()

		// Create multiple records to test pagination
		await pool.query(
			`INSERT INTO products (id, name, price) VALUES (1, 'Product 1', 10.00)`,
		)

		// Create 10 updates to have enough data for pagination
		for (let i = 1; i <= 10; i++) {
			await pool.query(`UPDATE products SET price = ${10.0 + i} WHERE id = 1`)
		}

		const { app } = await createServer({
			pool,
			enableHistory: true,
			historyConfig: {
				tables: ['products'],
			},
		})

		// Get first page with limit
		const page1Res = await app.request('/api/history/products/1?limit=5')
		expect(page1Res.status).toBe(200)
		const page1 = await page1Res.json()

		expect(page1.data.length).toBe(5)
		expect(page1.hasMore).toBe(true)
		expect(page1.nextCursor).toBeDefined()

		// Get second page using cursor
		const page2Res = await app.request(
			`/api/history/products/1?limit=5&cursor=${page1.nextCursor}`,
		)
		expect(page2Res.status).toBe(200)
		const page2 = await page2Res.json()

		expect(page2.data.length).toBeGreaterThan(0)

		// Verify no overlap between pages
		const page1Ids = page1.data.map((entry: AuditEntry) => entry.id)
		const page2Ids = page2.data.map((entry: AuditEntry) => entry.id)
		const overlap = page1Ids.filter((id: string) => page2Ids.includes(id))
		expect(overlap.length).toBe(0)

		await pgHistory.teardown()
	})

	test('should handle JWT authentication when enabled', async () => {
		// Save original env
		const originalSecret = process.env.PG_HISTORY_JWT_SECRET

		try {
			// Enable JWT auth
			process.env.PG_HISTORY_JWT_SECRET = 'test-secret-key'

			const pool = await getTestConnection()

			await pool.query(`
				CREATE TABLE IF NOT EXISTS items (
					id SERIAL PRIMARY KEY,
					name TEXT
				)
			`)

			const pgHistory = new PgHistory({
				tables: ['items'],
				pool,
			})
			await pgHistory.setup()

			const { app } = await createServer({
				pool,
				enableHistory: true,
				historyConfig: {
					tables: ['items'],
				},
			})

			// Request without JWT should fail
			const noAuthRes = await app.request('/api/history/items/1')
			expect(noAuthRes.status).toBe(401)

			// Request to non-authenticated endpoint should still work
			const healthRes = await app.request('/health')
			expect(healthRes.status).toBe(200)

			await pgHistory.teardown()
		} finally {
			// Restore original env
			if (originalSecret === undefined) {
				delete process.env.PG_HISTORY_JWT_SECRET
			} else {
				process.env.PG_HISTORY_JWT_SECRET = originalSecret
			}
		}
	})
})
