#!/usr/bin/env bun
/**
 * REST API Server
 *
 * Demonstrates: running the Hono-based REST API with history
 * endpoints enabled, then exercising it with fetch calls.
 *
 * Run:
 *   docker compose up -d
 *   bun examples/rest-api-server.ts
 */

import { Client, Pool } from 'pg'
import { createServer } from '../src/server'

const DB_NAME = `pg_history_api_${Date.now()}`
const ADMIN_URL =
	process.env.DATABASE_URL ||
	'postgres://postgres:postgres@localhost:5432/postgres'
const PORT = 3456

async function main() {
	const admin = new Client({ connectionString: ADMIN_URL })
	await admin.connect()
	await admin.query(`CREATE DATABASE "${DB_NAME}"`)
	await admin.end()

	const connStr = ADMIN_URL.replace(/\/[^/]*$/, `/${DB_NAME}`)
	const pool = new Pool({ connectionString: connStr })

	// Create application table
	await pool.query(`
    CREATE TABLE tasks (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      done BOOLEAN DEFAULT false
    )
  `)

	// Create and start the server
	const { app } = await createServer({
		pool,
		port: PORT,
		enableHistory: true,
		historyConfig: { tables: ['tasks'] },
	})

	// setup() must be called separately when using createServer
	const { PgHistory } = await import('../src')
	const history = new PgHistory({ pool, tables: ['tasks'] })
	await history.setup()

	const server = Bun.serve({ port: PORT, fetch: app.fetch })
	const base = `http://localhost:${PORT}`

	try {
		console.log(`Server running at ${base}\n`)

		// ── Health check ───────────────────────────────────────
		const health = await fetch(`${base}/health`).then((r) => r.json())
		console.log('GET /health →', health)

		// ── Insert some data via SQL ───────────────────────────
		await pool.query(`INSERT INTO tasks (title) VALUES ('Buy groceries')`)
		await pool.query(`INSERT INTO tasks (title) VALUES ('Write tests')`)
		await pool.query(`UPDATE tasks SET done = true WHERE id = 1`)
		console.log('\nInserted 2 tasks, completed task #1')

		// ── GET /api/history/:table/:recordId ──────────────────
		console.log('\n=== GET /api/history/tasks/1 ===\n')

		const historyRes = await fetch(`${base}/api/history/tasks/1`).then((r) =>
			r.json(),
		)
		for (const entry of (
			historyRes as { data: Array<{ operation: string; newData: unknown }> }
		).data) {
			console.log(`  ${entry.operation}: ${JSON.stringify(entry.newData)}`)
		}

		// ── POST /api/history/search ───────────────────────────
		console.log('\n=== POST /api/history/search ===\n')

		const searchRes = await fetch(`${base}/api/history/search`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tables: ['tasks'],
				operation: 'INSERT',
			}),
		}).then((r) => r.json())

		const searchData = searchRes as {
			data: Array<{ recordId: string; newData: unknown }>
		}
		console.log(`  Found ${searchData.data.length} INSERT entries`)

		// ── POST /api/history/revert ───────────────────────────
		console.log('\n=== POST /api/history/revert ===\n')

		const taskHistory = await fetch(`${base}/api/history/tasks/1`).then((r) =>
			r.json(),
		)
		const entries = (
			taskHistory as {
				data: Array<{
					id: string
					operation: string
					newData: Record<string, unknown>
				}>
			}
		).data

		// Revert the UPDATE (done=true → done=false) by targeting the UPDATE entry
		const updateEntry = entries.find((e) => e.operation === 'UPDATE')

		if (updateEntry) {
			console.log(`  Reverting UPDATE entry ${updateEntry.id}...`)

			const revertRes = await fetch(`${base}/api/history/revert`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					table: 'tasks',
					recordId: '1',
					auditEntryId: updateEntry.id,
				}),
			}).then((r) => r.json())

			console.log('  Revert result:', revertRes)

			const after = await pool.query(`SELECT * FROM tasks WHERE id = 1`)
			console.log(
				`  Task #1 after revert: done=${after.rows[0].done} (was true, now false)`,
			)
		}

		console.log('\nDone.')
	} finally {
		server.stop()
		await history.teardown()
		await pool.end()

		const cleanup = new Client({ connectionString: ADMIN_URL })
		await cleanup.connect()
		await cleanup.query(`DROP DATABASE "${DB_NAME}"`)
		await cleanup.end()
		console.log('Server stopped, database dropped.')
	}
}

main().catch(console.error)
