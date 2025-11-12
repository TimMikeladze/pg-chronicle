import { describe, expect, test } from 'bun:test'
import { createLogger } from '../../src/logger'

describe('Logger', () => {
	test('should output structured JSON logs', () => {
		const logs: string[] = []
		const logger = createLogger({
			correlationId: 'test-123',
			write: (msg: string) => logs.push(msg),
		})

		logger.info('test message', { key: 'value' })

		const parsed = JSON.parse(logs[0]!)
		expect(parsed.level).toBe('info')
		expect(parsed.message).toBe('test message')
		expect(parsed.correlation_id).toBe('test-123')
		expect(parsed.key).toBe('value')
		expect(parsed.timestamp).toBeDefined()
	})

	test('should support different log levels', () => {
		const logs: string[] = []
		const logger = createLogger({
			correlationId: 'test-123',
			write: (msg: string) => logs.push(msg),
		})

		logger.debug('debug')
		logger.info('info')
		logger.warn('warn')
		logger.error('error')

		expect(logs.length).toBe(4)
		expect(JSON.parse(logs[0]!).level).toBe('debug')
		expect(JSON.parse(logs[1]!).level).toBe('info')
		expect(JSON.parse(logs[2]!).level).toBe('warn')
		expect(JSON.parse(logs[3]!).level).toBe('error')
	})

	test('should merge context fields', () => {
		const logs: string[] = []
		const logger = createLogger({
			correlationId: 'test-123',
			write: (msg: string) => logs.push(msg),
		})

		logger.info('message', {
			table_name: 'users',
			batch_number: 1,
			records: 100,
		})

		const parsed = JSON.parse(logs[0]!)
		expect(parsed.table_name).toBe('users')
		expect(parsed.batch_number).toBe(1)
		expect(parsed.records).toBe(100)
	})
})
