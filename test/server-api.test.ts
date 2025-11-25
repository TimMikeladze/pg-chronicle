import { describe, expect, test } from 'bun:test'
import { Pool } from 'pg'
import { createErrorResponse } from '../src/api-helpers'
import { createServer } from '../src/server'
import type { ErrorResponse, ServerConfig } from '../src/types'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('Server API Types', () => {
	test('ServerConfig should accept historyConfig', () => {
		const pool = new Pool()
		const config: ServerConfig = {
			pool,
			port: 3001,
			historyConfig: {
				tables: ['users', 'posts'],
			},
		}
		expect(config.historyConfig?.tables).toEqual(['users', 'posts'])
		pool.end()
	})

	test('ErrorResponse type should have correct structure', () => {
		const error: ErrorResponse = {
			error: {
				code: 'VALIDATION_ERROR',
				message: 'Invalid input',
				details: { field: 'userId' },
			},
		}
		expect(error.error.code).toBe('VALIDATION_ERROR')
	})

	test('createErrorResponse should format error correctly', () => {
		const response = createErrorResponse('NOT_FOUND', 'Record not found', {
			id: '123',
		})
		expect(response.error.code).toBe('NOT_FOUND')
		expect(response.error.message).toBe('Record not found')
		expect(response.error.details).toEqual({ id: '123' })
	})

	test('server should initialize PgHistory when historyConfig provided', async () => {
		const pool = await getTestConnection()
		const app = await createServer({
			pool,
			port: 3001,
			enableHistory: true,
			historyConfig: {
				tables: ['users'],
			},
		})

		// Make a request that would fail if PgHistory not initialized
		const res = await app.request('/health')
		expect(res.status).toBe(200)
	})
})
