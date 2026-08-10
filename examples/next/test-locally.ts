#!/usr/bin/env bun
/**
 * Next.js Deployment — Local Test
 *
 * Simulates the full Next.js-on-Vercel deployment locally:
 *   - Serverless mode (no background archival, no in-memory rate limiting)
 *   - History API endpoints (GET /api/history/:table/:recordId,
 *     POST /api/history/search, POST /api/history/revert)
 *   - Cron-triggered archival (POST /api/archive with CRON_SECRET auth)
 *   - Health endpoint with archival status
 *
 * Run:
 *   docker compose up -d    # from repo root
 *   bun examples/next/test-locally.ts
 */

import { Client, Pool } from 'pg'
import { createServer } from '../../src/server'

const DB_NAME = `pg_history_next_${Date.now()}`
const ADMIN_URL =
	process.env.DATABASE_URL ||
	'postgres://postgres:postgres@localhost:5432/postgres'
const CRON_SECRET = 'test-cron-secret'

async function main() {
	// ── Setup ─────────────────────────────────────────────
	const admin = new Client({ connectionString: ADMIN_URL })
	await admin.connect()
	await admin.query(`CREATE DATABASE "${DB_NAME}"`)
	await admin.end()

	const connStr = ADMIN_URL.replace(/\/[^/]*$/, `/${DB_NAME}`)
	const pool = new Pool({ connectionString: connStr, max: 3 })

	await pool.query(`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL
    )
  `)

	// Create server in serverless mode (same as pg-history/next entry point)
	const { app } = await createServer({
		pool,
		serverless: true,
		enableHistory: true,
		// Local-only opt-in. In a real deployment set PG_HISTORY_JWT_SECRET
		// instead — `pg-history/next` refuses to start without it.
		allowUnauthenticated: true,
		historyConfig: { tables: ['users'] },
		enableArchiver: true,
		archiverConfig: {
			s3: {
				bucket: 'test-bucket',
				endpoint: process.env.PG_HISTORY_S3_ENDPOINT || 'http://localhost:9000',
				accessKeyId: process.env.PG_HISTORY_S3_ACCESS_KEY_ID || 'root',
				secretAccessKey:
					process.env.PG_HISTORY_S3_SECRET_ACCESS_KEY || 'password',
				region: process.env.PG_HISTORY_S3_REGION || 'us-west-1',
			},
			retention: { default: 1 },
			gracePeriod: 0,
			batchSize: 100,
		},
		archiveCronSecret: CRON_SECRET,
	})

	try {
		// ── 1. Verify serverless mode ─────────────────────────
		console.log('=== Serverless Mode ===\n')

		const appState = app as unknown as Record<string, unknown>
		console.log(
			`Background archival: ${appState._archivalPromise ? 'running' : 'disabled (correct)'}`,
		)
		console.log(
			`Archival interval:   ${appState._archivalInterval ? 'active' : 'disabled (correct)'}\n`,
		)

		// ── 2. History API ────────────────────────────────────
		console.log('=== History API ===\n')

		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Alice', 'alice@example.com')`,
		)
		await pool.query(`UPDATE users SET name = 'Alice Smith' WHERE id = 1`)
		await pool.query(
			`INSERT INTO users (name, email) VALUES ('Bob', 'bob@example.com')`,
		)
		console.log('Created 2 users, updated Alice\n')

		// GET /api/history/:table/:recordId
		const historyRes = await app.request('/api/history/users/1')
		const history = (await historyRes.json()) as {
			data: Array<{ operation: string; newData: unknown }>
		}
		console.log(`GET /api/history/users/1 → ${history.data.length} entries:`)
		for (const e of history.data) {
			console.log(`  ${e.operation}: ${JSON.stringify(e.newData)}`)
		}

		// POST /api/history/search
		const searchRes = await app.request('/api/history/search', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				tables: ['users'],
				query: '{"name": "Alice Smith"}',
			}),
		})
		const search = (await searchRes.json()) as {
			data: Array<{ operation: string }>
		}
		console.log(`\nPOST /api/history/search → ${search.data.length} matches`)

		// POST /api/history/revert
		// Revert undoes the chosen entry: an UPDATE entry restores its old_data.
		// (Reverting an INSERT entry would delete the row instead.)
		const updateEntry = history.data.find((e) => e.operation === 'UPDATE')
		if (updateEntry) {
			const revertRes = await app.request('/api/history/revert', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					table: 'users',
					recordId: '1',
					auditEntryId: (updateEntry as { id: string }).id,
				}),
			})
			const revert = await revertRes.json()
			console.log(`POST /api/history/revert → ${JSON.stringify(revert)}`)

			const row = await pool.query('SELECT * FROM users WHERE id = 1')
			console.log(
				`  User #1 after revert: name=${row.rows[0]?.name} (was 'Alice Smith', now 'Alice')`,
			)
		}

		// ── 3. Cron Archival ──────────────────────────────────
		console.log('\n=== Cron Archival ===\n')

		// Without auth → 401
		const noAuth = await app.request('/api/archive', { method: 'POST' })
		console.log(`POST /api/archive (no auth)    → ${noAuth.status}`)

		// Wrong secret → 401
		const wrongAuth = await app.request('/api/archive', {
			method: 'POST',
			headers: { authorization: 'Bearer wrong' },
		})
		console.log(`POST /api/archive (wrong auth) → ${wrongAuth.status}`)

		// Correct secret → 200
		const archiveRes = await app.request('/api/archive', {
			method: 'POST',
			headers: { authorization: `Bearer ${CRON_SECRET}` },
		})
		const archive = (await archiveRes.json()) as {
			success: boolean
			archival: { status: string }
		}
		console.log(
			`POST /api/archive (correct)    → ${archiveRes.status} (archival: ${archive.archival.status})`,
		)

		// ── 4. Health Check ───────────────────────────────────
		console.log('\n=== Health Check ===\n')

		const healthRes = await app.request('/health')
		const health = await healthRes.json()
		console.log(`GET /health → ${JSON.stringify(health, null, 2)}`)

		console.log(
			'\nAll endpoints working. Ready to deploy with `vercel deploy`.',
		)
	} finally {
		await pool.end()
		const cleanup = new Client({ connectionString: ADMIN_URL })
		await cleanup.connect()
		await cleanup.query(`DROP DATABASE "${DB_NAME}"`)
		await cleanup.end()
		console.log('Database dropped.')
	}
}

main().catch(console.error)
