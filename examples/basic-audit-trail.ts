#!/usr/bin/env bun
/**
 * Basic Audit Trail
 *
 * Demonstrates: setup, automatic trigger-based tracking,
 * history retrieval with pagination, and teardown.
 *
 * Run:
 *   docker compose up -d
 *   bun examples/basic-audit-trail.ts
 */

import { Client, Pool } from 'pg'
import { PgHistory } from '../src'
import { assert, assertEqual, run } from './_assert'

const DB_NAME = `pg_history_example_${Date.now()}`
const ADMIN_URL =
	process.env.DATABASE_URL ||
	'postgres://postgres:postgres@localhost:5432/postgres'

async function main() {
	// ── 1. Create a fresh database ────────────────────────────
	const admin = new Client({ connectionString: ADMIN_URL })
	await admin.connect()
	await admin.query(`CREATE DATABASE "${DB_NAME}"`)
	await admin.end()

	const connStr = ADMIN_URL.replace(/\/[^/]*$/, `/${DB_NAME}`)
	const pool = new Pool({ connectionString: connStr })

	try {
		// ── 2. Create application tables ──────────────────────────
		await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        role TEXT DEFAULT 'member'
      )
    `)
		console.log('Created users table\n')

		// ── 3. Set up pg-history ──────────────────────────────────
		const history = new PgHistory({ pool, tables: ['users'] })
		await history.setup()
		console.log('History tracking enabled\n')

		// ── 4. Make some changes (triggers capture everything) ───
		await pool.query(`INSERT INTO users (name, email) VALUES ($1, $2)`, [
			'Alice',
			'alice@example.com',
		])
		console.log('INSERT  → Alice created')

		await pool.query(`UPDATE users SET role = $1 WHERE name = $2`, [
			'admin',
			'Alice',
		])
		console.log('UPDATE  → Alice promoted to admin')

		await pool.query(`UPDATE users SET email = $1 WHERE name = $2`, [
			'alice@newdomain.com',
			'Alice',
		])
		console.log('UPDATE  → Alice changed email')

		await pool.query(`DELETE FROM users WHERE name = $1`, ['Alice'])
		console.log('DELETE  → Alice removed\n')

		// ── 5. Query the full history ─────────────────────────────
		const result = await history.getHistory('users', '1')

		console.log(`History for users:1 (${result.data.length} entries):`)
		console.log('─'.repeat(60))

		for (const entry of result.data) {
			const ts = entry.changedAt.toISOString().slice(0, 19)
			console.log(`  [${ts}] ${entry.operation}`)

			if (entry.oldData) {
				console.log(`    old: ${JSON.stringify(entry.oldData)}`)
			}
			if (entry.newData) {
				console.log(`    new: ${JSON.stringify(entry.newData)}`)
			}
		}

		console.log('─'.repeat(60))
		console.log(`hasMore: ${result.hasMore}, nextCursor: ${result.nextCursor}`)

		// ── Verify what we just demonstrated ──────────────────────
		assertEqual(result.data.length, 4, 'expected 4 audit entries for users:1')
		assertEqual(
			result.data.map((e) => e.operation).join(','),
			'DELETE,UPDATE,UPDATE,INSERT',
			'entries should be newest-first',
		)
		assertEqual(result.hasMore, false, 'all entries fit in one page')

		const insert = result.data[3]
		assert(insert?.oldData == null, 'INSERT has no oldData')
		assertEqual(
			(insert?.newData as Record<string, unknown>)?.role,
			'member',
			'Alice started as a member',
		)

		const del = result.data[0]
		assert(del?.newData == null, 'DELETE has no newData')
		assertEqual(
			(del?.oldData as Record<string, unknown>)?.email,
			'alice@newdomain.com',
			'DELETE captured the final email',
		)

		// ── 6. Clean up ───────────────────────────────────────────
		await history.teardown()
		await pool.end()

		const cleanup = new Client({ connectionString: ADMIN_URL })
		await cleanup.connect()
		await cleanup.query(`DROP DATABASE "${DB_NAME}"`)
		await cleanup.end()

		console.log('\nDone — database dropped.')
	} catch (err) {
		await pool.end()
		const cleanup = new Client({ connectionString: ADMIN_URL })
		await cleanup.connect()
		await cleanup.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`).catch(() => {})
		await cleanup.end()
		throw err
	}
}

run(main)
