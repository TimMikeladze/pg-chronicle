#!/usr/bin/env bun
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { SQL } from 'bun'
import { loadConfig } from './config'
import { HealthServer } from './health'
import { createLogger } from './logger'
import { Orchestrator } from './orchestrator'
import { setupArchiverSchema } from './schema'

interface CliOptions {
	config: string
	dryRun: boolean
	table?: string
	healthPort: number
	help: boolean
}

function showHelp() {
	console.log(`
pg-history-archiver - Archive old history records to S3

USAGE:
  bun run cli.ts [OPTIONS]

OPTIONS:
  --config <path>       Path to config file (default: ./archiver.config.json)
  --dry-run            Show what would be archived without doing it
  --table <name>       Process only specific table
  --health-port <port> Health check HTTP port (default: 3001)
  --help               Show this help message

EXAMPLES:
  # Archive all tables
  bun run cli.ts --config ./archiver.config.json

  # Dry run
  bun run cli.ts --dry-run

  # Archive specific table
  bun run cli.ts --table users

  # Custom health port
  bun run cli.ts --health-port 3002

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
			config: {
				type: 'string',
				default: './archiver.config.json',
			},
			'dry-run': {
				type: 'boolean',
				default: false,
			},
			table: {
				type: 'string',
			},
			'health-port': {
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
		config: values.config as string,
		dryRun: values['dry-run'] as boolean,
		table: values.table as string | undefined,
		healthPort: values['health-port']
			? Number.parseInt(values['health-port'] as string, 10)
			: 3001,
		help: values.help as boolean,
	}
}

async function main() {
	const opts = parseCliArgs()

	if (opts.help) {
		showHelp()
		process.exit(0)
	}

	const correlationId = randomUUID()
	const logger = createLogger({ correlationId })

	logger.info('Starting pg-history-archiver', {
		config: opts.config,
		dry_run: opts.dryRun,
		target_table: opts.table,
	})

	try {
		// Load config
		const config = await loadConfig({ configPath: opts.config })
		logger.info('Config loaded', {
			retention_default: config.retention.default,
		})

		// Start health check server
		const healthServer = new HealthServer({
			port: opts.healthPort || config.healthPort || 3001,
		})
		healthServer.start()

		// Connect to database
		const sql = new SQL(config.database.url)
		logger.info('Connected to database')

		// Ensure schema is set up
		await setupArchiverSchema(sql)
		logger.info('Schema verified')

		// Run orchestrator
		const orchestrator = new Orchestrator(config)
		const stats = await orchestrator.run(sql, {
			dryRun: opts.dryRun,
			targetTable: opts.table,
		})

		// Update health server with results
		healthServer.updateLastRun(stats)

		// Log summary
		logger.info('Archival complete', {
			tables: stats.tables.length,
			records_archived: stats.totalRecordsArchived,
			records_soft_deleted: stats.totalRecordsSoftDeleted,
			records_hard_deleted: stats.totalRecordsHardDeleted,
			errors: stats.errors.length,
			duration_ms: stats.durationMs,
		})

		// Log errors if any
		for (const error of stats.errors) {
			logger.error('Table processing error', error)
		}

		// Close connection
		await sql.close()

		// Stop health server
		healthServer.stop()

		// Exit code
		if (stats.errors.length > 0) {
			process.exit(1) // Partial failure
		}
		process.exit(0)
	} catch (error) {
		logger.error('Fatal error', {
			error: error instanceof Error ? error.message : String(error),
			stack: error instanceof Error ? error.stack : undefined,
		})
		process.exit(2)
	}
}

main()
