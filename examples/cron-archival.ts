#!/usr/bin/env bun
/**
 * Cron-Triggered Archival
 *
 * Demonstrates: using POST /api/archive to trigger archival on demand,
 * as you would from Vercel Cron, AWS EventBridge, or a cron job.
 * Also shows cron secret authentication.
 *
 * Run:
 *   docker compose up -d
 *   bun examples/cron-archival.ts
 */

import { Client, Pool } from 'pg'
import { createServer } from '../src/server'
import { assertEqual, run } from './_assert'

const DB_NAME = `pg_chronicle_cron_${Date.now()}`
const ADMIN_URL =
	process.env.DATABASE_URL ||
	'postgres://postgres:postgres@localhost:5432/postgres'
const CRON_SECRET = 'my-cron-secret-123'

async function main() {
	const admin = new Client({ connectionString: ADMIN_URL })
	await admin.connect()
	await admin.query(`CREATE DATABASE "${DB_NAME}"`)
	await admin.end()

	const connStr = ADMIN_URL.replace(/\/[^/]*$/, `/${DB_NAME}`)
	const pool = new Pool({ connectionString: connStr })

	await pool.query(`
    CREATE TABLE events (
      id SERIAL PRIMARY KEY,
      type TEXT NOT NULL,
      payload JSONB
    )
  `)

	// Create server in serverless mode with archiver enabled.
	// This local demo opts out of JWT (createServer fails closed without one);
	// /api/archive below is still protected by the cron secret. In production set
	// PG_CHRONICLE_JWT_SECRET and an `authorize` hook instead.
	const { app } = await createServer({
		pool,
		serverless: true,
		allowUnauthenticated: true,
		enableHistory: true,
		historyConfig: { tables: ['events'] },
		enableArchiver: true,
		archiverConfig: {
			s3: {
				bucket: 'test-bucket',
				endpoint:
					process.env.PG_CHRONICLE_S3_ENDPOINT || 'http://localhost:9000',
				accessKeyId: process.env.PG_CHRONICLE_S3_ACCESS_KEY_ID || 'root',
				secretAccessKey:
					process.env.PG_CHRONICLE_S3_SECRET_ACCESS_KEY || 'password',
				region: process.env.PG_CHRONICLE_S3_REGION || 'us-west-1',
			},
			retention: { default: 1 }, // 1 day for demo purposes
			gracePeriod: 0,
			batchSize: 100,
		},
		archiveCronSecret: CRON_SECRET,
	})

	try {
		// Generate some audit data
		for (let i = 0; i < 5; i++) {
			await pool.query(`INSERT INTO events (type, payload) VALUES ($1, $2)`, [
				'user.signup',
				JSON.stringify({ userId: i + 1 }),
			])
		}
		console.log('Inserted 5 events\n')

		// ── 1. Try without auth ──────────────────────────────
		console.log('1. POST /api/archive without auth...')
		const noAuthRes = await app.request('/api/archive', { method: 'POST' })
		console.log(`   Status: ${noAuthRes.status} (expected 401)`)
		const noAuthBody = await noAuthRes.json()
		console.log(`   Response: ${JSON.stringify(noAuthBody)}\n`)
		assertEqual(noAuthRes.status, 401, 'archive must reject unauthenticated')

		// ── 2. Try with wrong secret ─────────────────────────
		console.log('2. POST /api/archive with wrong secret...')
		const wrongRes = await app.request('/api/archive', {
			method: 'POST',
			headers: { authorization: 'Bearer wrong-secret' },
		})
		console.log(`   Status: ${wrongRes.status} (expected 401)\n`)
		assertEqual(wrongRes.status, 401, 'archive must reject a wrong secret')

		// ── 3. Trigger archival with correct secret ──────────
		console.log('3. POST /api/archive with correct secret...')
		const archiveRes = await app.request('/api/archive', {
			method: 'POST',
			headers: { authorization: `Bearer ${CRON_SECRET}` },
		})
		console.log(`   Status: ${archiveRes.status}`)
		const archiveBody = await archiveRes.json()
		console.log(`   Response: ${JSON.stringify(archiveBody, null, 2)}\n`)
		assertEqual(
			archiveRes.status,
			200,
			'correct cron secret should be accepted',
		)
		assertEqual(
			(archiveBody as { success?: boolean }).success,
			true,
			'archival run should report success',
		)

		// ── 4. Check health for archival status ──────────────
		console.log('4. GET /health...')
		const healthRes = await app.request('/health')
		const health = await healthRes.json()
		console.log(`   ${JSON.stringify(health, null, 2)}`)
		assertEqual(
			(health as { status?: string }).status,
			'ok',
			'/health should report ok after archival',
		)

		console.log('\nDone.')
	} finally {
		await pool.end()
		const cleanup = new Client({ connectionString: ADMIN_URL })
		await cleanup.connect()
		await cleanup.query(`DROP DATABASE "${DB_NAME}"`)
		await cleanup.end()
		console.log('Database dropped.')
	}
}

run(main)
