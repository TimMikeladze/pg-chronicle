#!/usr/bin/env bun
/**
 * Error Handling
 *
 * Demonstrates: typed error classes for programmatic error handling.
 * Shows how to catch specific errors and handle them differently.
 *
 * Run:
 *   docker compose up -d
 *   bun examples/error-handling.ts
 */

import { Client, Pool } from 'pg'
import { PgHistory } from '../src'
import {
	AuditEntryNotFoundError,
	PgHistoryError,
	SetupRequiredError,
	TableNotConfiguredError,
} from '../src/errors'

const DB_NAME = `pg_history_errors_${Date.now()}`
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

	await pool.query(`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL
    )
  `)

	try {
		// ── 1. SetupRequiredError ─────────────────────────────
		console.log('1. Calling getHistory() before setup()...')
		const history = new PgHistory({ pool, tables: ['users'] })

		try {
			await history.getHistory('users', '1')
		} catch (error) {
			if (error instanceof SetupRequiredError) {
				console.log(`   Caught SetupRequiredError: ${error.message}`)
			}
		}

		// Now set up properly
		await history.setup()
		console.log('   setup() called — ready to go\n')

		// ── 2. TableNotConfiguredError ────────────────────────
		console.log('2. Querying a table not in the configured list...')

		try {
			await history.getHistory('orders', '1')
		} catch (error) {
			if (error instanceof TableNotConfiguredError) {
				console.log(`   Caught TableNotConfiguredError: ${error.message}`)
			}
		}

		// ── 3. AuditEntryNotFoundError ───────────────────────
		console.log('\n3. Reverting with a non-existent audit entry ID...')

		await pool.query(`INSERT INTO users (name) VALUES ('Alice')`)

		try {
			await history.revert('users', '1', '99999')
		} catch (error) {
			if (error instanceof AuditEntryNotFoundError) {
				console.log(`   Caught AuditEntryNotFoundError: ${error.message}`)
			}
		}

		// ── 4. Catching any pg-history error ─────────────────
		console.log('\n4. Using the base PgHistoryError class...')

		try {
			await history.search({
				tables: ['nonexistent'],
			})
		} catch (error) {
			if (error instanceof PgHistoryError) {
				console.log(
					`   Caught PgHistoryError (${error.constructor.name}): ${error.message}`,
				)
			}
		}

		// ── 5. Invalid operation validation ──────────────────
		console.log('\n5. Passing an invalid operation to search...')

		try {
			await history.search({
				tables: ['users'],
				// @ts-expect-error intentionally passing invalid operation
				operation: 'TRUNCATE',
			})
		} catch (error) {
			if (error instanceof Error) {
				console.log(`   Caught Error: ${error.message}`)
			}
		}

		console.log('\nAll error cases handled gracefully.')
		await history.teardown()
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
