#!/usr/bin/env bun
/**
 * User Tracking
 *
 * Demonstrates: attributing changes to users via setUser() and withUser(),
 * attaching metadata (IP, request ID), and querying by changed_by.
 *
 * Run:
 *   docker compose up -d
 *   bun examples/user-tracking.ts
 */

import { Client, Pool } from 'pg'
import { PgHistory } from '../src'

const DB_NAME = `pg_history_user_tracking_${Date.now()}`
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
      CREATE TABLE products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        price NUMERIC(10,2) NOT NULL,
        stock INT DEFAULT 0
      )
    `)

		const history = new PgHistory({ pool, tables: ['products'] })
		await history.setup()

		// ── withUser: wraps a transaction with user context ──────
		console.log('=== withUser() — automatic transaction handling ===\n')

		await history.withUser(
			'warehouse-bot',
			{ source: 'inventory-sync' },
			async (client) => {
				await client.query(
					`INSERT INTO products (name, price, stock) VALUES ($1, $2, $3)`,
					['Widget A', 9.99, 100],
				)
				await client.query(
					`INSERT INTO products (name, price, stock) VALUES ($1, $2, $3)`,
					['Widget B', 19.99, 50],
				)
			},
		)
		console.log('warehouse-bot added 2 products')

		await history.withUser(
			'admin-jane',
			{ ip: '10.0.0.42', requestId: 'req-7a3' },
			async (client) => {
				await client.query(`UPDATE products SET price = $1 WHERE name = $2`, [
					12.99,
					'Widget A',
				])
			},
		)
		console.log('admin-jane updated Widget A price')

		// ── setUser: manual client management ────────────────────
		console.log('\n=== setUser() — manual client management ===\n')

		const client = await pool.connect()
		try {
			await client.query('BEGIN')
			await history.setUser(client, 'api-user-456', {
				endpoint: '/api/products',
				method: 'PATCH',
			})

			await client.query(
				`UPDATE products SET stock = stock - 5 WHERE name = $1`,
				['Widget B'],
			)
			await client.query('COMMIT')
			console.log('api-user-456 decremented Widget B stock')
		} finally {
			client.release()
		}

		// ── Query history and inspect changed_by / metadata ──────
		console.log('\n=== Audit trail with user attribution ===\n')

		const widgetAHistory = await history.getHistory('products', '1')
		for (const entry of widgetAHistory.data) {
			console.log(
				`  ${entry.operation.padEnd(6)} by ${entry.changedBy ?? '(unknown)'}`,
			)
			if (entry.metadata) {
				console.log(`         metadata: ${JSON.stringify(entry.metadata)}`)
			}
		}

		// ── Search by changedBy ──────────────────────────────────
		console.log('\n=== Search: all changes by warehouse-bot ===\n')

		const botChanges = await history.search({
			tables: ['products'],
			changedBy: 'warehouse-bot',
		})
		console.log(`  Found ${botChanges.data.length} entries by warehouse-bot`)

		for (const entry of botChanges.data) {
			const name = (entry.newData as Record<string, unknown>)?.name
			console.log(`  → ${entry.operation} product: ${name}`)
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
