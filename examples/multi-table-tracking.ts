#!/usr/bin/env bun
/**
 * Multi-Table Tracking
 *
 * Demonstrates: tracking multiple related tables, composite primary keys,
 * and cross-table search.
 *
 * Run:
 *   docker compose up -d
 *   bun examples/multi-table-tracking.ts
 */

import { Client, Pool } from 'pg'
import { PgChronicle } from '../src'
import { assert, assertEqual, run } from './_assert'

const DB_NAME = `pg_chronicle_multi_table_${Date.now()}`
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
		// ── Create related tables ────────────────────────────────
		await pool.query(`
      CREATE TABLE customers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        tier TEXT DEFAULT 'free'
      )
    `)

		await pool.query(`
      CREATE TABLE invoices (
        id SERIAL PRIMARY KEY,
        customer_id INT REFERENCES customers(id),
        amount NUMERIC(10,2) NOT NULL,
        status TEXT DEFAULT 'draft'
      )
    `)

		// Composite PK table — record_id is customer_id || chr(31) || tag
		await pool.query(`
      CREATE TABLE customer_tags (
        customer_id INT REFERENCES customers(id),
        tag TEXT NOT NULL,
        PRIMARY KEY (customer_id, tag)
      )
    `)

		// ── Track all three tables ───────────────────────────────
		const history = new PgChronicle({
			pool,
			tables: ['customers', 'invoices', 'customer_tags'],
		})
		await history.setup()
		console.log('Tracking: customers, invoices, customer_tags\n')

		// ── Make changes across tables ───────────────────────────
		await pool.query(
			`INSERT INTO customers (name, tier) VALUES ('Acme Corp', 'pro')`,
		)
		await pool.query(
			`INSERT INTO invoices (customer_id, amount) VALUES (1, 500.00)`,
		)
		await pool.query(`INSERT INTO customer_tags VALUES (1, 'enterprise')`)
		await pool.query(`INSERT INTO customer_tags VALUES (1, 'priority')`)
		console.log('Created customer + invoice + 2 tags')

		await pool.query(`UPDATE invoices SET status = 'sent' WHERE id = 1`)
		await pool.query(`UPDATE invoices SET status = 'paid' WHERE id = 1`)
		console.log('Invoice sent → paid')

		await pool.query(
			`DELETE FROM customer_tags WHERE customer_id = 1 AND tag = 'priority'`,
		)
		await pool.query(`UPDATE customers SET tier = 'enterprise' WHERE id = 1`)
		console.log('Removed tag, upgraded tier\n')

		// ── Cross-table search ───────────────────────────────────
		console.log('=== Cross-table search: all changes ===\n')

		const allChanges = await history.search({
			tables: ['customers', 'invoices', 'customer_tags'],
		})

		for (const entry of allChanges.data) {
			console.log(
				`  ${entry.tableName.padEnd(15)} ${entry.operation.padEnd(6)} record=${entry.recordId}`,
			)
		}

		// 4 INSERTs + 3 UPDATEs + 1 DELETE across the three tables.
		assertEqual(allChanges.data.length, 8, 'expected 8 entries across 3 tables')
		const tablesSeen = new Set(allChanges.data.map((e) => e.tableName))
		assertEqual(tablesSeen.size, 3, 'all three tables should appear in search')

		// ── Composite PK history ─────────────────────────────────
		// Composite PKs are joined with chr(31) (ASCII unit separator), not a
		// human-readable delimiter — build the record_id the same way.
		const compositeId = (...parts: string[]) => parts.join('\x1f')

		console.log(
			'\n=== Composite PK: customer_tags history for (1, enterprise) ===\n',
		)

		const tagHistory = await history.getHistory(
			'customer_tags',
			compositeId('1', 'enterprise'),
		)
		for (const entry of tagHistory.data) {
			console.log(
				`  ${entry.operation}: ${JSON.stringify(entry.newData || entry.oldData)}`,
			)
		}

		// The 'enterprise' tag was only inserted, never removed.
		assertEqual(tagHistory.data.length, 1, 'enterprise tag has one entry')
		assertEqual(tagHistory.data[0]?.operation, 'INSERT', 'and it is the INSERT')

		console.log(
			'\n=== Composite PK: customer_tags history for (1, priority) ===\n',
		)

		const removedTagHistory = await history.getHistory(
			'customer_tags',
			compositeId('1', 'priority'),
		)
		for (const entry of removedTagHistory.data) {
			console.log(
				`  ${entry.operation}: ${JSON.stringify(entry.newData || entry.oldData)}`,
			)
		}

		// The 'priority' tag was inserted then deleted — proves the chr(31)
		// composite record_id round-trips for both operations.
		assertEqual(
			removedTagHistory.data.map((e) => e.operation).join(','),
			'DELETE,INSERT',
			'priority tag should have a DELETE and an INSERT',
		)

		// ── Invoice lifecycle ────────────────────────────────────
		console.log('\n=== Invoice #1 full lifecycle ===\n')

		const invoiceHistory = await history.getHistory('invoices', '1', {
			order: 'asc',
		})
		const statuses: unknown[] = []
		for (const entry of invoiceHistory.data) {
			const status =
				(entry.newData as Record<string, unknown>)?.status ?? '(deleted)'
			statuses.push(status)
			console.log(`  ${entry.operation.padEnd(6)} → status: ${status}`)
		}

		// order: 'asc' means oldest-first, so the lifecycle reads forward.
		assertEqual(
			statuses.join(','),
			'draft,sent,paid',
			'invoice lifecycle in ascending order',
		)
		assert(
			invoiceHistory.data[0]?.operation === 'INSERT',
			'ascending order starts with the INSERT',
		)

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
