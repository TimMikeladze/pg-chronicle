#!/usr/bin/env bun
import { parseArgs } from 'node:util'
import pkg from 'pg'

const { Pool } = pkg

import { loadConfig } from './config'
import { Orchestrator } from './orchestrator'
import { setupArchiverSchema } from './schema'
import { createServer } from './server'

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

	console.log('Starting pg-history-archiver', {
		config: opts.config,
		dryRun: opts.dryRun,
		targetTable: opts.table,
	})

	try {
		// Load config
		const config = await loadConfig({ configPath: opts.config })
		console.log('Config loaded', {
			retentionDefault: config.retention.default,
		})

		// Connect to database
		const pool = new Pool({ connectionString: config.database.url })
		console.log('Connected to database')

		// Ensure schema is set up
		await setupArchiverSchema(pool)
		console.log('Schema verified')

		// Start API server
		const app = createServer(pool, config)
		const port = opts.healthPort || config.healthPort || 3001

		const server = Bun.serve({
			port,
			fetch: app.fetch,
		})

		console.log(`Server running on http://localhost:${server.port}`)
		console.log(
			`OpenAPI docs available at http://localhost:${server.port}/openapi`,
		)

		// Run orchestrator
		const orchestrator = new Orchestrator(config)
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
