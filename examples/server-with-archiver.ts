#!/usr/bin/env bun
/**
 * Example: Running pg-history server with archiver
 *
 * This example shows how to run the API server
 * with archival functionality enabled.
 */

import { Pool } from 'pg'
import { Orchestrator } from '../src/orchestrator'
import { setupArchiverSchema } from '../src/schema'
import { createServer } from '../src/server'

const pool = new Pool({
	connectionString:
		process.env.PG_HISTORY_DATABASE_URL || 'postgres://localhost:5432/mydb',
})

// Setup archiver schema
await setupArchiverSchema(pool)

const s3Config = {
	bucket: process.env.PG_HISTORY_S3_BUCKET || 'my-audit-bucket',
	endpoint: process.env.PG_HISTORY_S3_ENDPOINT,
	region: process.env.PG_HISTORY_S3_REGION || 'us-east-1',
	accessKeyId: process.env.PG_HISTORY_S3_ACCESS_KEY_ID,
	secretAccessKey: process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY,
}

const retentionConfig = {
	default: 90,
	tables: {
		users: 30,
		logs: 7,
	},
}

// Create server with archiver enabled
const app = createServer({
	pool,
	port: 3001,
	enableArchiver: true,
	archiverConfig: {
		s3: s3Config,
		retention: retentionConfig,
		gracePeriod: 7,
		batchSize: 10000,
	},
})

const server = Bun.serve({
	port: 3001,
	fetch: app.fetch,
})

console.log('Server running on http://localhost:3001')
console.log('OpenAPI docs: http://localhost:3001/openapi')
console.log('Health check: http://localhost:3001/health')
console.log('Archival stats: http://localhost:3001/api/stats')
console.log('\nArchiver is ENABLED')

// Run archival process
const orchestrator = new Orchestrator(s3Config, retentionConfig, 7, 10000)

console.log('\nRunning archival process...')
const stats = await orchestrator.run(pool, { dryRun: false })

console.log('Archival complete:', {
	tables: stats.tables.length,
	recordsArchived: stats.totalRecordsArchived,
	recordsSoftDeleted: stats.totalRecordsSoftDeleted,
	recordsHardDeleted: stats.totalRecordsHardDeleted,
	errors: stats.errors.length,
})

// Graceful shutdown
process.on('SIGTERM', async () => {
	console.log('Shutting down...')
	server.stop()
	await pool.end()
	process.exit(0)
})

process.on('SIGINT', async () => {
	console.log('Shutting down...')
	server.stop()
	await pool.end()
	process.exit(0)
})
