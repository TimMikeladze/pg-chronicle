#!/usr/bin/env node
/**
 * Node.js consumer smoke test.
 *
 * Verifies the bunup build output is actually consumable from a plain Node.js
 * project: both module systems, every published subpath, the CLI bin, and a
 * real audit-trail round trip against Postgres.
 *
 * Run:
 *   npm install && npm start
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { Client, Pool } from 'pg'
import {
	createServer,
	Orchestrator,
	PgHistory,
	PgHistoryArchiver,
} from 'pg-history'

const require = createRequire(import.meta.url)

const DB_NAME = `pg_history_node_example_${Date.now()}`
const ADMIN_URL =
	process.env.DATABASE_URL ||
	'postgres://postgres:postgres@localhost:5432/postgres'

let passed = 0
async function check(name, fn) {
	await fn()
	passed++
	console.log(`  ✓ ${name}`)
}

async function checkModuleFormats() {
	console.log('Module formats')

	await check('ESM import exposes the public API', () => {
		for (const [name, value] of Object.entries({
			PgHistory,
			PgHistoryArchiver,
			Orchestrator,
			createServer,
		})) {
			assert.equal(typeof value, 'function', `${name} should be a function`)
		}
	})

	await check('CommonJS require resolves the same API', () => {
		const cjs = require('pg-history')
		assert.equal(typeof cjs.PgHistory, 'function')
		assert.equal(typeof cjs.createServer, 'function')
		assert.equal(cjs.PgHistory.name, PgHistory.name)
	})

	await check(
		'the ./next subpath exports a Next.js route handler',
		async () => {
			const next = await import('pg-history/next')
			for (const method of ['GET', 'POST']) {
				assert.equal(typeof next[method], 'function', `next.${method}`)
			}
		},
	)

	await check('the CLI bin loads under Node', () => {
		// The server entrypoint refuses to boot without a database URL — reaching
		// that error proves the bundle parsed and ran under Node.
		const pkg = require.resolve('pg-history/package.json')
		const cli = pkg.replace(/package\.json$/, 'dist/main.js')
		const out = spawnSync(process.execPath, [cli], {
			encoding: 'utf8',
			env: { ...process.env, PG_HISTORY_DATABASE_URL: '' },
		})
		assert.equal(
			out.status,
			1,
			`expected a clean config failure, got ${out.status}`,
		)
		assert.match(
			out.stdout + out.stderr,
			/PG_HISTORY_DATABASE_URL environment variable is required/,
		)
	})
}

async function checkAuditTrail() {
	console.log('\nAudit trail round trip')

	const admin = new Client({ connectionString: ADMIN_URL })
	await admin.connect()
	await admin.query(`CREATE DATABASE "${DB_NAME}"`)
	await admin.end()

	const pool = new Pool({
		connectionString: ADMIN_URL.replace(/\/[^/]*$/, `/${DB_NAME}`),
	})

	try {
		await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT DEFAULT 'member'
      )
    `)

		const history = new PgHistory({ pool, tables: ['users'] })
		await history.setup()

		await pool.query(`INSERT INTO users (name, email) VALUES ($1, $2)`, [
			'Alice',
			'alice@example.com',
		])
		await pool.query(`UPDATE users SET role = $1 WHERE name = $2`, [
			'admin',
			'Alice',
		])
		await pool.query(`DELETE FROM users WHERE name = $1`, ['Alice'])

		const result = await history.getHistory('users', '1')

		await check('triggers captured every operation, newest first', () => {
			assert.equal(
				result.data.map((e) => e.operation).join(','),
				'DELETE,UPDATE,INSERT',
			)
		})

		await check('INSERT and DELETE payloads round trip as JSON', () => {
			const insert = result.data.at(-1)
			assert.equal(insert.oldData, null)
			assert.equal(insert.newData.role, 'member')

			const del = result.data[0]
			assert.equal(del.newData, null)
			assert.equal(del.oldData.email, 'alice@example.com')
		})

		await check('changedAt deserializes to a Date', () => {
			assert.ok(result.data[0].changedAt instanceof Date)
		})

		await history.teardown()
	} finally {
		await pool.end()
		const cleanup = new Client({ connectionString: ADMIN_URL })
		await cleanup.connect()
		await cleanup.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`).catch(() => {})
		await cleanup.end()
	}
}

console.log(`Node ${process.version}\n`)
await checkModuleFormats()
await checkAuditTrail()
console.log(`\nDone — ${passed} checks passed, database dropped.`)
