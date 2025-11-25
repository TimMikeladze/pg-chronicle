#!/usr/bin/env bun
/**
 * Example: Running pg-history server with archiver
 *
 * This example shows how to run the API server
 * with archival functionality enabled. The archiver runs
 * automatically when the server starts.
 */

import { Pool } from 'pg'
import { createServer } from '../src/server'

const pool = new Pool({
	connectionString:
		process.env.PG_HISTORY_DATABASE_URL || 'postgres://localhost:5432/mydb',
})

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
// The archiver will run automatically before the server starts
const app = await createServer({
	pool,
	port: 3001,
	enableArchiver: true,
	archiverConfig: {
		s3: s3Config,
		retention: retentionConfig,
		gracePeriod: 7,
		batchSize: 10000,
	},
	runOptions: {
		dryRun: false, // Set to true to preview what would be archived
		// targetTable: 'users', // Optionally archive only specific table
	},
})

const server = Bun.serve({
	port: 3001,
	fetch: app.fetch,
})

console.log('\n=== Server Started ===')
console.log('Server running on http://localhost:3001')
console.log('OpenAPI docs: http://localhost:3001/openapi')
console.log('Health check: http://localhost:3001/health')
console.log('Archival stats: http://localhost:3001/api/stats')

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
