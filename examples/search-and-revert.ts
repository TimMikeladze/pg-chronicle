#!/usr/bin/env bun
/**
 * Search & Revert
 *
 * Demonstrates: JSONB containment search, text search,
 * filtering by operation/date, and reverting a record
 * to a previous state.
 *
 * Run:
 *   docker compose up -d
 *   bun examples/search-and-revert.ts
 */

import { Client, Pool } from 'pg'
import { PgHistory } from '../src'
import { assert, assertEqual, run } from './_assert'

const DB_NAME = `pg_history_search_revert_${Date.now()}`
const ADMIN_URL =
	process.env.DATABASE_URL ||
	'postgres://postgres:postgres@localhost:5432/postgres'

async function main() {
	const admin = new Client({ connectionString: ADMIN_URL })
	await admin.connect()
	await admin.query(`CREATE DATABASE "${DB_NAME}"`)
	await admin.end()

	const connStr = ADMIN_URL.replace(/\/[^/]*$/, `/${DB_NAME}`)
	const pool = new Pool({ connectionString: connStr })

	try {
		await pool.query(`
      CREATE TABLE orders (
        id SERIAL PRIMARY KEY,
        customer TEXT NOT NULL,
        total NUMERIC(10,2) NOT NULL,
        status TEXT DEFAULT 'pending'
      )
    `)

		const history = new PgHistory({ pool, tables: ['orders'] })
		await history.setup()

		// ── Seed some data ───────────────────────────────────────
		await pool.query(
			`INSERT INTO orders (customer, total, status) VALUES ($1, $2, $3)`,
			['Alice', 150.0, 'pending'],
		)
		await pool.query(
			`INSERT INTO orders (customer, total, status) VALUES ($1, $2, $3)`,
			['Bob', 89.5, 'pending'],
		)

		await pool.query(
			`UPDATE orders SET status = 'shipped' WHERE customer = 'Alice'`,
		)
		await pool.query(
			`UPDATE orders SET status = 'shipped' WHERE customer = 'Bob'`,
		)

		await pool.query(
			`UPDATE orders SET status = 'refunded', total = 0 WHERE customer = 'Alice'`,
		)

		console.log('=== JSONB containment search ===\n')

		// Search for records containing specific JSON — uses GIN index
		const refundedOrders = await history.search({
			tables: ['orders'],
			query: '{"status": "refunded"}',
		})
		console.log(`Orders with status "refunded": ${refundedOrders.data.length}`)
		for (const entry of refundedOrders.data) {
			console.log(`  ${entry.operation} order #${entry.recordId}`)
		}

		// Only Alice's order was refunded — one matching UPDATE entry.
		assertEqual(
			refundedOrders.data.length,
			1,
			'containment search should match the single refunded order',
		)
		assertEqual(
			refundedOrders.data[0]?.recordId,
			'1',
			'refunded order is order #1 (Alice)',
		)

		console.log('\n=== Text search ===\n')

		// Plain text search — falls back to ILIKE
		const aliceResults = await history.search({
			tables: ['orders'],
			query: 'Alice',
		})
		console.log(`Entries mentioning "Alice": ${aliceResults.data.length}`)

		// 1 INSERT + 2 UPDATEs all mention Alice.
		assertEqual(
			aliceResults.data.length,
			3,
			'text search should match 3 entries',
		)
		assert(
			aliceResults.data.every((e) => e.recordId === '1'),
			'every Alice match belongs to order #1',
		)

		console.log('\n=== Filter by operation ===\n')

		const updates = await history.search({
			tables: ['orders'],
			operation: 'UPDATE',
		})
		console.log(`Total UPDATE entries: ${updates.data.length}`)

		// 2 shipped + 1 refund.
		assertEqual(updates.data.length, 3, 'expected 3 UPDATE entries')
		assert(
			updates.data.every((e) => e.operation === 'UPDATE'),
			'operation filter should exclude INSERTs',
		)

		// ── Revert Alice's order back to "shipped" state ─────────
		console.log('\n=== Revert ===\n')

		const aliceHistory = await history.getHistory('orders', '1', {
			order: 'desc',
		})

		// Find the entry where Alice's order was shipped (before the refund)
		const shippedEntry = aliceHistory.data.find(
			(e) =>
				e.operation === 'UPDATE' &&
				(e.newData as Record<string, unknown>)?.status === 'shipped',
		)

		assert(shippedEntry, 'expected an UPDATE entry with status "shipped"')

		console.log('Current state:')
		const current = await pool.query(`SELECT * FROM orders WHERE id = 1`)
		console.log(`  ${JSON.stringify(current.rows[0])}`)
		assertEqual(current.rows[0].status, 'refunded', 'order starts out refunded')

		console.log(`\nReverting order #1 to audit entry ${shippedEntry.id}...`)
		await history.revert('orders', '1', shippedEntry.id)

		const after = await pool.query(`SELECT * FROM orders WHERE id = 1`)
		console.log(`\nAfter revert:`)
		console.log(`  ${JSON.stringify(after.rows[0])}`)

		// revert() restores the state *before* the target entry — the UPDATE that
		// set status='shipped' had oldData status='pending', total=150.
		assertEqual(after.rows[0].status, 'pending', 'revert restored the status')
		assertEqual(after.rows[0].total, '150.00', 'revert restored the total')

		// The revert itself is audited
		const postRevert = await history.getHistory('orders', '1', { limit: 1 })
		const revertEntry = postRevert.data[0]
		assert(revertEntry, 'the revert should produce its own audit entry')
		console.log(`\nRevert audit entry:`)
		console.log(`  operation: ${revertEntry.operation}`)
		assertEqual(revertEntry.operation, 'UPDATE', 'revert is recorded as UPDATE')

		// ── Clean up ─────────────────────────────────────────────
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
