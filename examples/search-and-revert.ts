#!/usr/bin/env bun
/**
 * Search & Revert
 *
 * Demonstrates: JSONB containment search, text search,
 * filtering by operation/date/user, and reverting a record
 * to a previous state.
 *
 * Run:
 *   docker compose up -d
 *   bun examples/search-and-revert.ts
 */

import { Client, Pool } from 'pg'
import { PgHistory } from '../src'

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
		await history.withUser('system', undefined, async (client) => {
			await client.query(
				`INSERT INTO orders (customer, total, status) VALUES ($1, $2, $3)`,
				['Alice', 150.0, 'pending'],
			)
			await client.query(
				`INSERT INTO orders (customer, total, status) VALUES ($1, $2, $3)`,
				['Bob', 89.5, 'pending'],
			)
		})

		await history.withUser('fulfillment-worker', undefined, async (client) => {
			await client.query(
				`UPDATE orders SET status = 'shipped' WHERE customer = 'Alice'`,
			)
			await client.query(
				`UPDATE orders SET status = 'shipped' WHERE customer = 'Bob'`,
			)
		})

		await history.withUser(
			'admin',
			{ reason: 'customer complaint' },
			async (client) => {
				await client.query(
					`UPDATE orders SET status = 'refunded', total = 0 WHERE customer = 'Alice'`,
				)
			},
		)

		console.log('=== JSONB containment search ===\n')

		// Search for records containing specific JSON — uses GIN index
		const refundedOrders = await history.search({
			tables: ['orders'],
			query: '{"status": "refunded"}',
		})
		console.log(`Orders with status "refunded": ${refundedOrders.data.length}`)
		for (const entry of refundedOrders.data) {
			console.log(
				`  ${entry.operation} order #${entry.recordId} by ${entry.changedBy}`,
			)
		}

		console.log('\n=== Text search ===\n')

		// Plain text search — falls back to ILIKE
		const aliceResults = await history.search({
			tables: ['orders'],
			query: 'Alice',
		})
		console.log(`Entries mentioning "Alice": ${aliceResults.data.length}`)

		console.log('\n=== Filter by operation ===\n')

		const updates = await history.search({
			tables: ['orders'],
			operation: 'UPDATE',
		})
		console.log(`Total UPDATE entries: ${updates.data.length}`)

		console.log('\n=== Filter by user ===\n')

		const adminChanges = await history.search({
			tables: ['orders'],
			changedBy: 'admin',
		})
		console.log(`Changes by "admin": ${adminChanges.data.length}`)

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

		if (shippedEntry) {
			console.log('Current state:')
			const current = await pool.query(`SELECT * FROM orders WHERE id = 1`)
			console.log(`  ${JSON.stringify(current.rows[0])}`)

			console.log(`\nReverting order #1 to audit entry ${shippedEntry.id}...`)
			await history.revert('orders', '1', shippedEntry.id, {
				userId: 'support-agent',
				metadata: { ticket: 'SUPPORT-1234' },
			})

			const after = await pool.query(`SELECT * FROM orders WHERE id = 1`)
			console.log(`\nAfter revert:`)
			console.log(`  ${JSON.stringify(after.rows[0])}`)

			// The revert itself is audited
			const postRevert = await history.getHistory('orders', '1', { limit: 1 })
			const revertEntry = postRevert.data[0]
			if (revertEntry) {
				console.log(`\nRevert audit entry:`)
				console.log(`  operation: ${revertEntry.operation}`)
				console.log(`  changedBy: ${revertEntry.changedBy}`)
				console.log(`  metadata:  ${JSON.stringify(revertEntry.metadata)}`)
			}
		}

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

main().catch(console.error)
