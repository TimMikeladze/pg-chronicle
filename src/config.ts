import { readFile } from 'node:fs/promises'
import type { ConfigFile, LoadConfigOptions } from './types'

function parsePositiveInt(value: string, fieldName: string): number {
	const parsed = Number.parseInt(value, 10)
	if (Number.isNaN(parsed)) {
		throw new Error(
			`Invalid value for ${fieldName}: "${value}" is not a valid number`,
		)
	}
	if (parsed <= 0) {
		throw new Error(
			`Invalid value for ${fieldName}: ${parsed} must be greater than 0`,
		)
	}
	return parsed
}

export async function loadConfig(
	options: LoadConfigOptions,
): Promise<ConfigFile> {
	// Load from file
	let fileContent: string
	try {
		fileContent = await readFile(options.configPath, 'utf-8')
	} catch (error) {
		if (error instanceof Error && 'code' in error) {
			if (error.code === 'ENOENT') {
				throw new Error(
					`Config file not found: ${options.configPath}. Please create a configuration file at this location.`,
				)
			}
			if (error.code === 'EACCES') {
				throw new Error(
					`Permission denied reading config file: ${options.configPath}. Please check file permissions.`,
				)
			}
		}
		throw new Error(
			`Failed to read config file: ${options.configPath}. ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	// Parse JSON
	let config: ConfigFile
	try {
		config = JSON.parse(fileContent)
	} catch (error) {
		throw new Error(
			`Invalid JSON in config file: ${options.configPath}. ${error instanceof Error ? error.message : String(error)}`,
		)
	}

	// Override with environment variables
	if (process.env.PG_AUDIT_DB_URL) {
		config.database.url = process.env.PG_AUDIT_DB_URL
	}
	if (process.env.PG_HISTORY_S3_BUCKET) {
		config.s3.bucket = process.env.PG_HISTORY_S3_BUCKET
	}
	if (process.env.PG_HISTORY_S3_ENDPOINT) {
		config.s3.endpoint = process.env.PG_HISTORY_S3_ENDPOINT
	}
	if (process.env.PG_HISTORY_S3_ACCESS_KEY_ID) {
		config.s3.accessKeyId = process.env.PG_HISTORY_S3_ACCESS_KEY_ID
	}
	if (process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY) {
		config.s3.secretAccessKey = process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY
	}
	if (process.env.PG_HISTORY_S3_REGION) {
		config.s3.region = process.env.PG_HISTORY_S3_REGION
	}
	if (process.env.ARCHIVE_RETENTION_DEFAULT) {
		config.retention.default = parsePositiveInt(
			process.env.ARCHIVE_RETENTION_DEFAULT,
			'ARCHIVE_RETENTION_DEFAULT',
		)
	}
	if (process.env.ARCHIVE_GRACE_PERIOD) {
		config.gracePeriod = parsePositiveInt(
			process.env.ARCHIVE_GRACE_PERIOD,
			'ARCHIVE_GRACE_PERIOD',
		)
	}
	if (process.env.ARCHIVE_BATCH_SIZE) {
		config.batchSize = parsePositiveInt(
			process.env.ARCHIVE_BATCH_SIZE,
			'ARCHIVE_BATCH_SIZE',
		)
	}
	if (process.env.HEALTH_PORT) {
		config.healthPort = parsePositiveInt(process.env.HEALTH_PORT, 'HEALTH_PORT')
	}

	// Apply manual overrides
	if (options.overrides) {
		Object.assign(config, options.overrides)
	}

	// Validate
	validateConfig(config)

	return config
}

export function validateConfig(config: unknown): asserts config is ConfigFile {
	const cfg = config as Partial<ConfigFile>

	if (!cfg.database?.url) {
		throw new Error('database.url is required')
	}
	if (!cfg.s3?.bucket) {
		throw new Error('s3.bucket is required')
	}
	if (!cfg.retention?.default || cfg.retention.default <= 0) {
		throw new Error('retention.default must be > 0')
	}
	if (!cfg.gracePeriod || cfg.gracePeriod <= 0) {
		throw new Error('gracePeriod must be > 0')
	}
	if (!cfg.batchSize || cfg.batchSize <= 0) {
		throw new Error('batchSize must be > 0')
	}
}
