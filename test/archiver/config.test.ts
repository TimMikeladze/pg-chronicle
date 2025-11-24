import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { loadConfig, validateConfig } from '../../src/config'

const testConfigPath = join(
	import.meta.dir,
	'../test-fixtures/valid-config.json',
)

describe('Config Loading', () => {
	afterEach(() => {
		// Clean up environment variables after each test
		delete process.env.PG_AUDIT_DB_URL
		delete process.env.PG_HISTORY_S3_BUCKET
		delete process.env.ARCHIVE_RETENTION_DEFAULT
		delete process.env.ARCHIVE_GRACE_PERIOD
		delete process.env.ARCHIVE_BATCH_SIZE
		delete process.env.HEALTH_PORT
	})

	test('should load config from file', async () => {
		const config = await loadConfig({
			configPath: testConfigPath,
		})

		expect(config.database.url).toContain('postgres://')
		expect(config.s3.bucket).toBeDefined()
		expect(config.retention.default).toBeGreaterThan(0)
	})

	test('should override with environment variables', async () => {
		process.env.PG_AUDIT_DB_URL = 'postgres://override@localhost/test'
		process.env.PG_HISTORY_S3_BUCKET = 'override-bucket'

		const config = await loadConfig({
			configPath: testConfigPath,
		})

		expect(config.database.url).toBe('postgres://override@localhost/test')
		expect(config.s3.bucket).toBe('override-bucket')
	})

	test('should validate required fields', () => {
		expect(() =>
			validateConfig({
				database: {},
				s3: {},
				retention: {},
			}),
		).toThrow('database.url is required')
	})

	test('should throw error for non-existent config file', async () => {
		const nonExistentPath = join(import.meta.dir, 'does-not-exist.json')

		await expect(
			loadConfig({
				configPath: nonExistentPath,
			}),
		).rejects.toThrow(/Config file not found/)
		await expect(
			loadConfig({
				configPath: nonExistentPath,
			}),
		).rejects.toThrow(/Please create a configuration file/)
	})

	test('should throw error for invalid JSON', async () => {
		const invalidJsonPath = join(
			import.meta.dir,
			'../test-fixtures/invalid-json.txt',
		)

		await expect(
			loadConfig({
				configPath: invalidJsonPath,
			}),
		).rejects.toThrow(/Invalid JSON in config file/)
	})

	test('should throw error for non-numeric environment variable', async () => {
		process.env.ARCHIVE_RETENTION_DEFAULT = 'not-a-number'

		await expect(
			loadConfig({
				configPath: testConfigPath,
			}),
		).rejects.toThrow(/Invalid value for ARCHIVE_RETENTION_DEFAULT/)
		await expect(
			loadConfig({
				configPath: testConfigPath,
			}),
		).rejects.toThrow(/not a valid number/)
	})

	test('should throw error for negative environment variable', async () => {
		process.env.ARCHIVE_GRACE_PERIOD = '-5'

		await expect(
			loadConfig({
				configPath: testConfigPath,
			}),
		).rejects.toThrow(/Invalid value for ARCHIVE_GRACE_PERIOD/)
		await expect(
			loadConfig({
				configPath: testConfigPath,
			}),
		).rejects.toThrow(/must be greater than 0/)
	})

	test('should throw error for zero environment variable', async () => {
		process.env.ARCHIVE_BATCH_SIZE = '0'

		await expect(
			loadConfig({
				configPath: testConfigPath,
			}),
		).rejects.toThrow(/Invalid value for ARCHIVE_BATCH_SIZE/)
		await expect(
			loadConfig({
				configPath: testConfigPath,
			}),
		).rejects.toThrow(/must be greater than 0/)
	})

	test('should handle NaN from parseInt', async () => {
		process.env.HEALTH_PORT = 'abc123'

		await expect(
			loadConfig({
				configPath: testConfigPath,
			}),
		).rejects.toThrow(/Invalid value for HEALTH_PORT/)
		await expect(
			loadConfig({
				configPath: testConfigPath,
			}),
		).rejects.toThrow(/not a valid number/)
	})
})
