#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import pkg from 'pg'

const { Pool } = pkg

import { Orchestrator } from './orchestrator'
import { setupArchiverSchema } from './schema'
import { createServer } from './server'
import type { RetentionConfig, S3Config } from './types'

interface CliOptions {
	dryRun: boolean
	table?: string
	port: number
	help: boolean
}

function showHelp() {
	console.log(`
pg-history-archiver - Archive old history records to S3

USAGE:
  bun run cli.ts [OPTIONS]

OPTIONS:
  --dry-run            Show what would be archived without doing it
  --table <name>       Process only specific table
  --port <port>        Server port (default: 3001)
  --help               Show this help message

ENVIRONMENT VARIABLES:
  PG_HISTORY_DATABASE_URL           PostgreSQL connection string (required)
  PG_HISTORY_S3_BUCKET              S3 bucket name (required)
  PG_HISTORY_S3_ENDPOINT            S3 endpoint URL (optional)
  PG_HISTORY_S3_REGION              S3 region (optional, default: us-east-1)
  PG_HISTORY_S3_ACCESS_KEY_ID       S3 access key (optional, uses AWS credentials chain)
  PG_HISTORY_S3_SECRET_ACCESS_KEY   S3 secret key (optional, uses AWS credentials chain)
  PG_HISTORY_RETENTION_DEFAULT_DAYS Default retention period in days (default: 90)
  PG_HISTORY_RETENTION_TABLES       JSON mapping of table names to retention days (optional)
                                    Example: {"users":30,"orders":365}
  PG_HISTORY_GRACE_PERIOD_DAYS      Grace period before deletion in days (default: 7)
  PG_HISTORY_BATCH_SIZE             Batch size for processing (default: 10000)
  PG_HISTORY_PORT                   Server port (default: 3001)
  PG_HISTORY_JWT_SECRET             JWT secret for API authentication (optional)

EXAMPLES:
  # Archive all tables
  PG_HISTORY_DATABASE_URL=postgres://... PG_HISTORY_S3_BUCKET=my-bucket bun run cli.ts

  # Dry run
  PG_HISTORY_DATABASE_URL=postgres://... PG_HISTORY_S3_BUCKET=my-bucket bun run cli.ts --dry-run

  # Archive specific table
  PG_HISTORY_DATABASE_URL=postgres://... PG_HISTORY_S3_BUCKET=my-bucket bun run cli.ts --table users

  # Per-table retention policies (users: 30 days, orders: 365 days)
  PG_HISTORY_RETENTION_TABLES='{"users":30,"orders":365}' bun run cli.ts

  # Custom port
  bun run cli.ts --port 3002

EXIT CODES:
  0 - Success (all tables processed)
  1 - Partial failure (some tables failed, check logs)
  2 - Fatal error (config invalid, DB unreachable)
`)
}

function parseCliArgs(): CliOptions {
	const { values } = parseArgs({
		args: process.argv.slice(2),
		options: {
			'dry-run': {
				type: 'boolean',
				default: false,
			},
			table: {
				type: 'string',
			},
			port: {
				type: 'string',
			},
			help: {
				type: 'boolean',
				default: false,
			},
		},
		allowPositionals: true,
	})

	return {
		dryRun: values['dry-run'] as boolean,
		table: values.table as string | undefined,
		port: values.port
			? Number.parseInt(values.port as string, 10)
			: Number.parseInt(process.env.PG_HISTORY_PORT || '3001', 10),
		help: values.help as boolean,
	}
}

function loadEnvConfig(): {
	databaseUrl: string
	s3Config: S3Config
	retentionConfig: RetentionConfig
	gracePeriod: number
	batchSize: number
} {
	const databaseUrl = process.env.PG_HISTORY_DATABASE_URL
	if (!databaseUrl) {
		throw new Error('PG_HISTORY_DATABASE_URL environment variable is required')
	}

	const s3Bucket = process.env.PG_HISTORY_S3_BUCKET
	if (!s3Bucket) {
		throw new Error('PG_HISTORY_S3_BUCKET environment variable is required')
	}

	const s3Config: S3Config = {
		bucket: s3Bucket,
		endpoint: process.env.PG_HISTORY_S3_ENDPOINT,
		region: process.env.PG_HISTORY_S3_REGION || 'us-east-1',
		accessKeyId: process.env.PG_HISTORY_S3_ACCESS_KEY_ID,
		secretAccessKey: process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY,
	}

	const retentionDefaultDays = process.env.PG_HISTORY_RETENTION_DEFAULT_DAYS
		? Number.parseInt(process.env.PG_HISTORY_RETENTION_DEFAULT_DAYS, 10)
		: 90

	if (Number.isNaN(retentionDefaultDays) || retentionDefaultDays <= 0) {
		throw new Error(
			'PG_HISTORY_RETENTION_DEFAULT_DAYS must be a positive number',
		)
	}

	const retentionConfig: RetentionConfig = {
		default: retentionDefaultDays,
	}

	// Parse per-table retention overrides from JSON
	if (process.env.PG_HISTORY_RETENTION_TABLES) {
		try {
			const tablesMapping = JSON.parse(process.env.PG_HISTORY_RETENTION_TABLES)
			if (typeof tablesMapping !== 'object' || Array.isArray(tablesMapping)) {
				throw new Error('PG_HISTORY_RETENTION_TABLES must be a JSON object')
			}

			// Validate all values are positive numbers
			const tables: Record<string, number> = {}
			for (const [tableName, days] of Object.entries(tablesMapping)) {
				const daysNum = Number(days)
				if (Number.isNaN(daysNum) || daysNum <= 0) {
					throw new Error(
						`Invalid retention days for table "${tableName}": ${days} must be a positive number`,
					)
				}
				tables[tableName] = daysNum
			}
			retentionConfig.tables = tables
		} catch (error) {
			if (error instanceof SyntaxError) {
				throw new Error(
					`PG_HISTORY_RETENTION_TABLES contains invalid JSON: ${error.message}`,
				)
			}
			throw error
		}
	}

	const gracePeriod = process.env.PG_HISTORY_GRACE_PERIOD_DAYS
		? Number.parseInt(process.env.PG_HISTORY_GRACE_PERIOD_DAYS, 10)
		: 7

	if (Number.isNaN(gracePeriod) || gracePeriod <= 0) {
		throw new Error('PG_HISTORY_GRACE_PERIOD_DAYS must be a positive number')
	}

	const batchSize = process.env.PG_HISTORY_BATCH_SIZE
		? Number.parseInt(process.env.PG_HISTORY_BATCH_SIZE, 10)
		: 10000

	if (Number.isNaN(batchSize) || batchSize <= 0) {
		throw new Error('PG_HISTORY_BATCH_SIZE must be a positive number')
	}

	return {
		databaseUrl,
		s3Config,
		retentionConfig,
		gracePeriod,
		batchSize,
	}
}

async function main() {
	const opts = parseCliArgs()

	if (opts.help) {
		showHelp()
		process.exit(0)
	}

	try {
		// Load environment config
		const envConfig = loadEnvConfig()
		console.log('Starting pg-history-archiver', {
			dryRun: opts.dryRun,
			targetTable: opts.table,
			retentionDefault: envConfig.retentionConfig.default,
			gracePeriod: envConfig.gracePeriod,
			batchSize: envConfig.batchSize,
		})

		// Connect to database
		const pool = new Pool({ connectionString: envConfig.databaseUrl })
		console.log('Connected to database')

		// Ensure schema is set up
		await setupArchiverSchema(pool)
		console.log('Schema verified')

		// Start API server with archiver enabled
		const app = createServer({
			pool,
			port: opts.port,
			enableArchiver: true,
			archiverConfig: {
				s3: envConfig.s3Config,
				retention: envConfig.retentionConfig,
				gracePeriod: envConfig.gracePeriod,
				batchSize: envConfig.batchSize,
			},
		})

		const server = Bun.serve({
			port: opts.port,
			fetch: app.fetch,
		})

		console.log(`Server running on http://localhost:${server.port}`)
		console.log(
			`OpenAPI docs available at http://localhost:${server.port}/openapi`,
		)

		// Run orchestrator
		const orchestrator = new Orchestrator(
			envConfig.s3Config,
			envConfig.retentionConfig,
			envConfig.gracePeriod,
			envConfig.batchSize,
		)
		const stats = await orchestrator.run(pool, {
			dryRun: opts.dryRun,
			targetTable: opts.table,
		})

		// Log summary
		console.log('Archival complete', {
			tables: stats.tables.length,
			recordsArchived: stats.totalRecordsArchived,
			recordsSoftDeleted: stats.totalRecordsSoftDeleted,
			recordsHardDeleted: stats.totalRecordsHardDeleted,
			errors: stats.errors.length,
			durationMs: stats.durationMs,
		})

		// Log errors if any
		for (const error of stats.errors) {
			console.error('Table processing error', error)
		}

		// Close connection
		await pool.end()

		// Stop server
		server.stop()

		// Exit code
		if (stats.errors.length > 0) {
			process.exit(1) // Partial failure
		}
		process.exit(0)
	} catch (error) {
		console.error('Fatal error', {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		})
		process.exit(2)
	}
}

main()
