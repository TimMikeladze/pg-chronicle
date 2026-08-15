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
import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as sleep } from 'node:timers/promises'
import { Client, Pool } from 'pg'
import {
	createServer,
	Orchestrator,
	PgChronicle,
	PgChronicleArchiver,
} from 'pg-chronicle'

const require = createRequire(import.meta.url)

const DB_NAME = `pg_chronicle_node_example_${Date.now()}`
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
			PgChronicle,
			PgChronicleArchiver,
			Orchestrator,
			createServer,
		})) {
			assert.equal(typeof value, 'function', `${name} should be a function`)
		}
	})

	await check('CommonJS require resolves the same API', () => {
		const cjs = require('pg-chronicle')
		assert.equal(typeof cjs.PgChronicle, 'function')
		assert.equal(typeof cjs.createServer, 'function')
		assert.equal(cjs.PgChronicle.name, PgChronicle.name)
	})

	await check(
		'the ./next subpath exports a Next.js route handler',
		async () => {
			const next = await import('pg-chronicle/next')
			// OPTIONS included: without it Next answers CORS preflight with 405.
			for (const method of ['GET', 'POST', 'OPTIONS']) {
				assert.equal(typeof next[method], 'function', `next.${method}`)
			}
			assert.equal(typeof next.createHandlers, 'function', 'createHandlers')
		},
	)

	await check('the CLI bin rejects a missing database URL', () => {
		// The server entrypoint refuses to boot without a database URL — reaching
		// that error proves the bundle parsed and ran under Node.
		const out = spawnSync(process.execPath, [cliPath()], {
			encoding: 'utf8',
			env: { ...process.env, PG_CHRONICLE_DATABASE_URL: '' },
		})
		assert.equal(
			out.status,
			1,
			`expected a clean config failure, got ${out.status}`,
		)
		assert.match(
			out.stdout + out.stderr,
			/PG_CHRONICLE_DATABASE_URL environment variable is required/,
		)
	})

	// Parsing is not serving. The entrypoint used to call `Bun.serve`
	// unconditionally, so a Node run got all the way past config validation and
	// then died with "Bun is not defined" — invisible to any check that stops at
	// the config error. This one binds a port and completes a request.
	await check('the CLI bin actually serves HTTP under Node', async () => {
		const port = 3000 + Math.floor(Math.random() * 20000)
		const child = spawn(process.execPath, [cliPath()], {
			env: {
				...process.env,
				PG_CHRONICLE_DATABASE_URL: ADMIN_URL,
				PG_CHRONICLE_PORT: String(port),
				// This check is about the HTTP listener, not the archiver. CI sets
				// S3 variables job-wide, and inheriting them would switch the
				// archiver on against a database with no audit_log — a real failure,
				// but not the one under test here.
				PG_CHRONICLE_S3_BUCKET: '',
				PG_CHRONICLE_TABLES: '',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		})
		let output = ''
		child.stdout.on('data', (d) => {
			output += d
		})
		child.stderr.on('data', (d) => {
			output += d
		})
		child.on('exit', (code) => {
			if (code !== 0 && code !== null) {
				output += `\n[server exited early with code ${code}]`
			}
		})

		try {
			let body
			for (let attempt = 0; attempt < 40; attempt++) {
				try {
					const response = await fetch(`http://127.0.0.1:${port}/health`)
					body = await response.json()
					break
				} catch {
					await sleep(250)
				}
			}
			assert.ok(body, `server never answered /health.\n${output}`)
			assert.equal(body.status, 'ok', `unexpected health payload.\n${output}`)
		} finally {
			child.kill('SIGTERM')
		}
	})
}

function cliPath() {
	const pkg = require.resolve('pg-chronicle/package.json')
	return pkg.replace(/package\.json$/, 'dist/main.js')
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

		const history = new PgChronicle({ pool, tables: ['users'] })
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
