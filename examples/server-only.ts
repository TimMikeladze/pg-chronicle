#!/usr/bin/env bun
/**
 * Example: Running pg-history server without archiver
 *
 * This example shows how to run just the API server
 * without the archival functionality.
 */

import { Pool } from 'pg'
import { createServer } from '../src/server'

const pool = new Pool({
	connectionString:
		process.env.PG_HISTORY_DATABASE_URL || 'postgres://localhost:5432/mydb',
})

// Create server without archiver
const app = createServer({
	pool,
	port: 3001,
	enableArchiver: false, // Server-only mode
})

const server = Bun.serve({
	port: 3001,
	fetch: app.fetch,
})

console.log('Server running on http://localhost:3001')
console.log('OpenAPI docs: http://localhost:3001/openapi')
console.log('Health check: http://localhost:3001/health')
console.log('\nArchiver is DISABLED - only serving API endpoints')

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
