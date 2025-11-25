import { describe, expect, test } from 'bun:test'
import { Pool } from 'pg'
import type { ErrorResponse, ServerConfig } from '../src/types'

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
})
