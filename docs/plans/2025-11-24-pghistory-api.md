# PgHistory REST API Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a RESTful API over PgHistory class to expose audit log querying, reverting, and user context management.

**Architecture:** RESTful endpoints with JWT authentication, extend ServerConfig with optional historyConfig, structured JSON error responses, PgHistory instance stored in Hono context.

**Tech Stack:** Hono, PgHistory, JWT middleware, TypeScript, Bun test

---

## Task 1: Extend Types for History API

**Files:**
- Modify: `src/types.ts:123-143`

**Step 1: Write the failing test**

Create: `test/server-api.test.ts`

```typescript
import { describe, expect, test } from 'bun:test'
import { createServer } from '../src/server'
import { Pool } from 'pg'
import type { ServerConfig } from '../src/types'

describe('Server API Types', () => {
	test('ServerConfig should accept historyConfig', () => {
		const pool = new Pool()
		const config: ServerConfig = {
			pool,
			port: 3001,
			historyConfig: {
				tables: ['users', 'posts']
			}
		}
		expect(config.historyConfig?.tables).toEqual(['users', 'posts'])
		pool.end()
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test test/server-api.test.ts`
Expected: TypeScript error - historyConfig does not exist on ServerConfig

**Step 3: Add historyConfig to ServerConfig**

In `src/types.ts`, add after line 143:

```typescript
	/** Enable PgHistory API integration */
	enableHistory?: boolean

	/** PgHistory configuration (required if enableHistory is true) */
	historyConfig?: {
		tables: string[]
	}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/server-api.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types.ts test/server-api.test.ts
git commit -m "feat: add historyConfig to ServerConfig type"
```

---

## Task 2: Add Error Response Types

**Files:**
- Modify: `src/types.ts:170`

**Step 1: Write the failing test**

Add to `test/server-api.test.ts`:

```typescript
import type { ErrorResponse } from '../src/types'

test('ErrorResponse type should have correct structure', () => {
	const error: ErrorResponse = {
		error: {
			code: 'VALIDATION_ERROR',
			message: 'Invalid input',
			details: { field: 'userId' }
		}
	}
	expect(error.error.code).toBe('VALIDATION_ERROR')
})
```

**Step 2: Run test to verify it fails**

Run: `bun test test/server-api.test.ts`
Expected: TypeScript error - Cannot find name 'ErrorResponse'

**Step 3: Add error response types**

In `src/types.ts`, add after line 170:

```typescript
export interface ErrorResponse {
	error: {
		code: string
		message: string
		details?: unknown
	}
}

export interface HistoryApiContext {
	Variables: {
		pgHistory?: import('./PgHistory').PgHistory
	}
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/server-api.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/types.ts test/server-api.test.ts
git commit -m "feat: add error response and context types for history API"
```

---

## Task 3: Create Error Helper Function

**Files:**
- Create: `src/api-helpers.ts`

**Step 1: Write the failing test**

Add to `test/server-api.test.ts`:

```typescript
import { createErrorResponse } from '../src/api-helpers'

test('createErrorResponse should format error correctly', () => {
	const response = createErrorResponse('NOT_FOUND', 'Record not found', { id: '123' })
	expect(response.error.code).toBe('NOT_FOUND')
	expect(response.error.message).toBe('Record not found')
	expect(response.error.details).toEqual({ id: '123' })
})
```

**Step 2: Run test to verify it fails**

Run: `bun test test/server-api.test.ts`
Expected: Cannot find module '../src/api-helpers'

**Step 3: Create api-helpers.ts**

Create `src/api-helpers.ts`:

```typescript
import type { ErrorResponse } from './types'

export function createErrorResponse(
	code: string,
	message: string,
	details?: unknown
): ErrorResponse {
	return {
		error: {
			code,
			message,
			details
		}
	}
}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/server-api.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/api-helpers.ts test/server-api.test.ts
git commit -m "feat: add error response helper function"
```

---

## Task 4: Initialize PgHistory in Server

**Files:**
- Modify: `src/server.ts:11-44`

**Step 1: Write the failing test**

Add to `test/server-api.test.ts`:

```typescript
import { setupTestDatabase } from './helpers/setup'
import { getTestPool } from './helpers/db'

setupTestDatabase()

test('server should initialize PgHistory when historyConfig provided', async () => {
	const pool = getTestPool()
	const app = await createServer({
		pool,
		port: 3001,
		enableHistory: true,
		historyConfig: {
			tables: ['users']
		}
	})

	// Make a request that would fail if PgHistory not initialized
	const res = await app.request('/health')
	expect(res.status).toBe(200)
})
```

**Step 2: Run test to verify it fails**

Run: `bun test test/server-api.test.ts`
Expected: PASS (but we need to verify initialization happens)

**Step 3: Add PgHistory initialization logic**

In `src/server.ts`, after line 13, add:

```typescript
import { PgHistory } from './PgHistory'
import type { HistoryApiContext } from './types'

export async function createServer(
	config: ServerConfig,
): Promise<Hono<HistoryApiContext>> {
	const app = new Hono<HistoryApiContext>()

	// Initialize PgHistory if enabled
	let pgHistory: PgHistory | undefined
	if (config.enableHistory && config.historyConfig) {
		console.log('Initializing PgHistory API...')
		pgHistory = new PgHistory({
			tables: config.historyConfig.tables,
			pool: config.pool
		})
	}

	// Store in context for route handlers
	app.use('*', async (c, next) => {
		if (pgHistory) {
			c.set('pgHistory', pgHistory)
		}
		await next()
	})
```

**Step 4: Update return type**

Change line 11-14 from:

```typescript
type Variables = JwtVariables

export async function createServer(
	config: ServerConfig,
): Promise<Hono<{ Variables: Variables }>> {
	const app = new Hono<{ Variables: Variables }>()
```

To:

```typescript
type Variables = JwtVariables & {
	pgHistory?: PgHistory
}

export async function createServer(
	config: ServerConfig,
): Promise<Hono<{ Variables: Variables }>> {
	const app = new Hono<{ Variables: Variables }>()

	// Initialize PgHistory if enabled
	let pgHistory: PgHistory | undefined
	if (config.enableHistory && config.historyConfig) {
		console.log('Initializing PgHistory API...')
		pgHistory = new PgHistory({
			tables: config.historyConfig.tables,
			pool: config.pool
		})
	}

	// Store in context for route handlers
	app.use('*', async (c, next) => {
		if (pgHistory) {
			c.set('pgHistory', pgHistory)
		}
		await next()
	})
```

**Step 5: Run test to verify it passes**

Run: `bun test test/server-api.test.ts`
Expected: PASS with console log "Initializing PgHistory API..."

**Step 6: Commit**

```bash
git add src/server.ts test/server-api.test.ts
git commit -m "feat: initialize PgHistory instance when historyConfig provided"
```

---

## Task 5: Implement GET /api/history/:table/:recordId

**Files:**
- Modify: `src/server.ts:70-71` (after /api/stats)

**Step 1: Write the failing test**

Add to `test/server-api.test.ts`:

```typescript
import { PgHistory } from '../src/PgHistory'

describe('GET /api/history/:table/:recordId', () => {
	test('should return 401 without JWT when secret is set', async () => {
		process.env.PG_HISTORY_JWT_SECRET = 'test-secret'

		const pool = getTestPool()
		const app = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] }
		})

		const res = await app.request('/api/history/users/123')
		expect(res.status).toBe(401)

		delete process.env.PG_HISTORY_JWT_SECRET
	})

	test('should return history for valid table and recordId', async () => {
		const pool = getTestPool()
		const pgHistory = new PgHistory({ tables: ['users'], pool })
		await pgHistory.setup()

		// Create test table
		await pool.query(`
			CREATE TABLE IF NOT EXISTS users (
				id SERIAL PRIMARY KEY,
				name TEXT
			)
		`)

		// Insert and update to create history
		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)
		await pool.query(`UPDATE users SET name = 'Bob' WHERE id = 1`)

		const app = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] }
		})

		const res = await app.request('/api/history/users/1')
		expect(res.status).toBe(200)

		const json = await res.json()
		expect(json.data).toBeArray()
		expect(json.data.length).toBeGreaterThan(0)
		expect(json).toHaveProperty('nextCursor')
		expect(json).toHaveProperty('hasMore')

		await pgHistory.teardown()
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test test/server-api.test.ts -t "GET /api/history"`
Expected: 404 Not Found

**Step 3: Implement the route**

In `src/server.ts`, after the `/api/stats` route (around line 70), add:

```typescript
	// History API endpoints (only if history enabled)
	if (config.enableHistory && pgHistory) {
		app.get('/api/history/:table/:recordId', async (c) => {
			const pgHistory = c.get('pgHistory')
			if (!pgHistory) {
				return c.json(createErrorResponse('NOT_CONFIGURED', 'PgHistory not initialized'), 500)
			}

			const table = c.req.param('table')
			const recordId = c.req.param('recordId')
			const limit = c.req.query('limit') ? Number.parseInt(c.req.query('limit')!, 10) : undefined
			const cursor = c.req.query('cursor') || undefined
			const order = (c.req.query('order') as 'asc' | 'desc') || 'desc'

			try {
				const result = await pgHistory.getHistory(table, recordId, {
					limit,
					cursor,
					order
				})
				return c.json(result)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)

				if (message.includes('not configured')) {
					return c.json(createErrorResponse('INVALID_TABLE', message), 400)
				}

				return c.json(createErrorResponse('DATABASE_ERROR', message), 500)
			}
		})
	}
```

Add import at top:

```typescript
import { createErrorResponse } from './api-helpers'
```

**Step 4: Run test to verify it passes**

Run: `bun test test/server-api.test.ts -t "GET /api/history"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server.ts test/server-api.test.ts
git commit -m "feat: implement GET /api/history/:table/:recordId endpoint"
```

---

## Task 6: Implement POST /api/history/search

**Files:**
- Modify: `src/server.ts` (after previous route)

**Step 1: Write the failing test**

Add to `test/server-api.test.ts`:

```typescript
describe('POST /api/history/search', () => {
	test('should search across multiple tables', async () => {
		const pool = getTestPool()
		const pgHistory = new PgHistory({ tables: ['users', 'posts'], pool })
		await pgHistory.setup()

		await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)`)
		await pool.query(`CREATE TABLE IF NOT EXISTS posts (id SERIAL PRIMARY KEY, title TEXT)`)
		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)
		await pool.query(`INSERT INTO posts (id, title) VALUES (1, 'Hello World')`)

		const app = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users', 'posts'] }
		})

		const res = await app.request('/api/history/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tables: ['users', 'posts'],
				operation: 'INSERT'
			})
		})

		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json.data).toBeArray()
		expect(json.data.length).toBe(2)

		await pgHistory.teardown()
	})

	test('should return 400 for empty tables array', async () => {
		const pool = getTestPool()
		const app = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] }
		})

		const res = await app.request('/api/history/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ tables: [] })
		})

		expect(res.status).toBe(400)
		const json = await res.json()
		expect(json.error.code).toBe('VALIDATION_ERROR')
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test test/server-api.test.ts -t "POST /api/history/search"`
Expected: 404 Not Found

**Step 3: Implement the route**

In `src/server.ts`, after the previous history route, add:

```typescript
		app.post('/api/history/search', async (c) => {
			const pgHistory = c.get('pgHistory')
			if (!pgHistory) {
				return c.json(createErrorResponse('NOT_CONFIGURED', 'PgHistory not initialized'), 500)
			}

			const body = await c.req.json()

			// Validate required fields
			if (!body.tables || !Array.isArray(body.tables) || body.tables.length === 0) {
				return c.json(
					createErrorResponse('VALIDATION_ERROR', 'tables array is required and must not be empty'),
					400
				)
			}

			try {
				const result = await pgHistory.search({
					tables: body.tables,
					query: body.query,
					operation: body.operation,
					dateFrom: body.dateFrom ? new Date(body.dateFrom) : undefined,
					dateTo: body.dateTo ? new Date(body.dateTo) : undefined,
					changedBy: body.changedBy,
					limit: body.limit,
					cursor: body.cursor
				})
				return c.json(result)
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)

				if (message.includes('not configured')) {
					return c.json(createErrorResponse('INVALID_TABLE', message), 400)
				}

				if (message.includes('must be') || message.includes('invalid')) {
					return c.json(createErrorResponse('VALIDATION_ERROR', message), 400)
				}

				return c.json(createErrorResponse('DATABASE_ERROR', message), 500)
			}
		})
```

**Step 4: Run test to verify it passes**

Run: `bun test test/server-api.test.ts -t "POST /api/history/search"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server.ts test/server-api.test.ts
git commit -m "feat: implement POST /api/history/search endpoint"
```

---

## Task 7: Implement POST /api/history/revert

**Files:**
- Modify: `src/server.ts` (after previous route)

**Step 1: Write the failing test**

Add to `test/server-api.test.ts`:

```typescript
describe('POST /api/history/revert', () => {
	test('should revert a record to previous state', async () => {
		const pool = getTestPool()
		const pgHistory = new PgHistory({ tables: ['users'], pool })
		await pgHistory.setup()

		await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)`)
		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)
		await pool.query(`UPDATE users SET name = 'Bob' WHERE id = 1`)

		// Get audit entry ID for the UPDATE
		const history = await pgHistory.getHistory('users', '1')
		const updateEntry = history.data.find(e => e.operation === 'UPDATE')
		expect(updateEntry).toBeDefined()

		const app = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] }
		})

		const res = await app.request('/api/history/revert', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tableName: 'users',
				recordId: '1',
				auditEntryId: updateEntry!.id
			})
		})

		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json.success).toBe(true)

		// Verify the revert happened
		const result = await pool.query('SELECT name FROM users WHERE id = 1')
		expect(result.rows[0].name).toBe('Alice')

		await pgHistory.teardown()
	})

	test('should return 400 for missing required fields', async () => {
		const pool = getTestPool()
		const app = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] }
		})

		const res = await app.request('/api/history/revert', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ tableName: 'users' })
		})

		expect(res.status).toBe(400)
		const json = await res.json()
		expect(json.error.code).toBe('VALIDATION_ERROR')
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test test/server-api.test.ts -t "POST /api/history/revert"`
Expected: 404 Not Found

**Step 3: Implement the route**

In `src/server.ts`, after the previous history route, add:

```typescript
		app.post('/api/history/revert', async (c) => {
			const pgHistory = c.get('pgHistory')
			if (!pgHistory) {
				return c.json(createErrorResponse('NOT_CONFIGURED', 'PgHistory not initialized'), 500)
			}

			const body = await c.req.json()

			// Validate required fields
			if (!body.tableName || !body.recordId || !body.auditEntryId) {
				return c.json(
					createErrorResponse(
						'VALIDATION_ERROR',
						'tableName, recordId, and auditEntryId are required'
					),
					400
				)
			}

			try {
				await pgHistory.revert(body.tableName, body.recordId, body.auditEntryId)
				return c.json({ success: true })
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)

				if (message.includes('not configured') || message.includes('not found')) {
					return c.json(createErrorResponse('NOT_FOUND', message), 404)
				}

				if (message.includes('must be') || message.includes('invalid')) {
					return c.json(createErrorResponse('VALIDATION_ERROR', message), 400)
				}

				return c.json(createErrorResponse('DATABASE_ERROR', message), 500)
			}
		})
```

**Step 4: Run test to verify it passes**

Run: `bun test test/server-api.test.ts -t "POST /api/history/revert"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server.ts test/server-api.test.ts
git commit -m "feat: implement POST /api/history/revert endpoint"
```

---

## Task 8: Implement POST /api/context/user

**Files:**
- Modify: `src/server.ts` (after previous route)

**Step 1: Write the failing test**

Add to `test/server-api.test.ts`:

```typescript
describe('POST /api/context/user', () => {
	test('should set user context', async () => {
		const pool = getTestPool()
		const pgHistory = new PgHistory({ tables: ['users'], pool })
		await pgHistory.setup()

		const app = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] }
		})

		const res = await app.request('/api/context/user', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				userId: 'user-123',
				metadata: { role: 'admin' }
			})
		})

		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json.success).toBe(true)

		await pgHistory.teardown()
	})

	test('should return 400 for missing userId', async () => {
		const pool = getTestPool()
		const app = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] }
		})

		const res = await app.request('/api/context/user', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ metadata: {} })
		})

		expect(res.status).toBe(400)
		const json = await res.json()
		expect(json.error.code).toBe('VALIDATION_ERROR')
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test test/server-api.test.ts -t "POST /api/context/user"`
Expected: 404 Not Found

**Step 3: Implement the route**

In `src/server.ts`, after the previous history route, add:

```typescript
		app.post('/api/context/user', async (c) => {
			const pgHistory = c.get('pgHistory')
			if (!pgHistory) {
				return c.json(createErrorResponse('NOT_CONFIGURED', 'PgHistory not initialized'), 500)
			}

			const body = await c.req.json()

			// Validate required fields
			if (!body.userId) {
				return c.json(
					createErrorResponse('VALIDATION_ERROR', 'userId is required'),
					400
				)
			}

			try {
				await pgHistory.setUser(body.userId, body.metadata)
				return c.json({ success: true })
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)

				if (message.includes('must be') || message.includes('invalid') || message.includes('exceeds')) {
					return c.json(createErrorResponse('VALIDATION_ERROR', message), 400)
				}

				return c.json(createErrorResponse('DATABASE_ERROR', message), 500)
			}
		})
```

**Step 4: Run test to verify it passes**

Run: `bun test test/server-api.test.ts -t "POST /api/context/user"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server.ts test/server-api.test.ts
git commit -m "feat: implement POST /api/context/user endpoint"
```

---

## Task 9: Implement DELETE /api/context/user

**Files:**
- Modify: `src/server.ts` (after previous route)

**Step 1: Write the failing test**

Add to `test/server-api.test.ts`:

```typescript
describe('DELETE /api/context/user', () => {
	test('should clear user context', async () => {
		const pool = getTestPool()
		const pgHistory = new PgHistory({ tables: ['users'], pool })
		await pgHistory.setup()

		// First set a user
		await pgHistory.setUser('user-123')

		const app = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] }
		})

		const res = await app.request('/api/context/user', {
			method: 'DELETE'
		})

		expect(res.status).toBe(200)
		const json = await res.json()
		expect(json.success).toBe(true)

		await pgHistory.teardown()
	})
})
```

**Step 2: Run test to verify it fails**

Run: `bun test test/server-api.test.ts -t "DELETE /api/context/user"`
Expected: 404 Not Found

**Step 3: Implement the route**

In `src/server.ts`, after the previous history route, add:

```typescript
		app.delete('/api/context/user', async (c) => {
			const pgHistory = c.get('pgHistory')
			if (!pgHistory) {
				return c.json(createErrorResponse('NOT_CONFIGURED', 'PgHistory not initialized'), 500)
			}

			try {
				await pgHistory.clearUser()
				return c.json({ success: true })
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error)
				return c.json(createErrorResponse('DATABASE_ERROR', message), 500)
			}
		})
	}
```

**Step 4: Run test to verify it passes**

Run: `bun test test/server-api.test.ts -t "DELETE /api/context/user"`
Expected: PASS

**Step 5: Commit**

```bash
git add src/server.ts test/server-api.test.ts
git commit -m "feat: implement DELETE /api/context/user endpoint"
```

---

## Task 10: Add Integration Test for Full Flow

**Files:**
- Modify: `test/server-api.test.ts`

**Step 1: Write the integration test**

Add to `test/server-api.test.ts`:

```typescript
describe('Full API Integration', () => {
	test('should handle complete audit workflow', async () => {
		const pool = getTestPool()
		const pgHistory = new PgHistory({ tables: ['users'], pool })
		await pgHistory.setup()

		await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT)`)

		const app = await createServer({
			pool,
			enableHistory: true,
			historyConfig: { tables: ['users'] }
		})

		// 1. Set user context
		let res = await app.request('/api/context/user', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ userId: 'admin-123', metadata: { role: 'admin' } })
		})
		expect(res.status).toBe(200)

		// 2. Make database changes
		await pool.query(`INSERT INTO users (id, name) VALUES (1, 'Alice')`)
		await pool.query(`UPDATE users SET name = 'Bob' WHERE id = 1`)

		// 3. Get history
		res = await app.request('/api/history/users/1')
		expect(res.status).toBe(200)
		let json = await res.json()
		expect(json.data.length).toBe(2)
		expect(json.data[0].changedBy).toBe('admin-123')

		// 4. Search for changes
		res = await app.request('/api/history/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tables: ['users'],
				changedBy: 'admin-123'
			})
		})
		expect(res.status).toBe(200)
		json = await res.json()
		expect(json.data.length).toBe(2)

		// 5. Revert to original
		const updateEntry = json.data.find((e: any) => e.operation === 'UPDATE')
		res = await app.request('/api/history/revert', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tableName: 'users',
				recordId: '1',
				auditEntryId: updateEntry.id
			})
		})
		expect(res.status).toBe(200)

		// 6. Verify revert
		const result = await pool.query('SELECT name FROM users WHERE id = 1')
		expect(result.rows[0].name).toBe('Alice')

		// 7. Clear context
		res = await app.request('/api/context/user', { method: 'DELETE' })
		expect(res.status).toBe(200)

		await pgHistory.teardown()
	})
})
```

**Step 2: Run test to verify it passes**

Run: `bun test test/server-api.test.ts -t "Full API Integration"`
Expected: PASS

**Step 3: Commit**

```bash
git add test/server-api.test.ts
git commit -m "test: add full API integration test"
```

---

## Task 11: Run All Tests and Fix Any Issues

**Step 1: Run all tests**

Run: `bun test`
Expected: All new tests passing, existing tests unchanged

**Step 2: Fix any TypeScript errors**

Run: `bunx tsc --noEmit`
Expected: No errors

**Step 3: Run linter**

Run: `bun run lint:fix`
Expected: No errors or auto-fixed

**Step 4: Final commit**

```bash
git add .
git commit -m "chore: fix linting and type issues"
```

---

## Completion

All tasks complete! The PgHistory REST API is now fully implemented with:

- ✅ GET /api/history/:table/:recordId - Query audit history
- ✅ POST /api/history/search - Search across tables
- ✅ POST /api/history/revert - Revert records
- ✅ POST /api/context/user - Set user context
- ✅ DELETE /api/context/user - Clear user context
- ✅ JWT authentication support
- ✅ Structured error responses
- ✅ Full test coverage
- ✅ Type safety

**Next Steps:**
- Review with @superpowers:requesting-code-review
- Merge with @superpowers:finishing-a-development-branch
