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
import { assertThrows, run } from './_assert'

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

		// assertThrows fails the example if the call *succeeds* or throws the
		// wrong error type — a silent `catch` would hide both.
		const setupErr = await assertThrows(
			() => history.getHistory('users', '1'),
			(e) => e instanceof SetupRequiredError,
			'getHistory() before setup() should throw SetupRequiredError',
		)
		console.log(`   Caught SetupRequiredError: ${(setupErr as Error).message}`)

		// Now set up properly
		await history.setup()
		console.log('   setup() called — ready to go\n')

		// ── 2. TableNotConfiguredError ────────────────────────
		console.log('2. Querying a table not in the configured list...')

		const tableErr = await assertThrows(
			() => history.getHistory('orders', '1'),
			(e) => e instanceof TableNotConfiguredError,
			'unconfigured table should throw TableNotConfiguredError',
		)
		console.log(
			`   Caught TableNotConfiguredError: ${(tableErr as Error).message}`,
		)

		// ── 3. AuditEntryNotFoundError ───────────────────────
		console.log('\n3. Reverting with a non-existent audit entry ID...')

		await pool.query(`INSERT INTO users (name) VALUES ('Alice')`)

		const revertErr = await assertThrows(
			() => history.revert('users', '1', '99999'),
			(e) => e instanceof AuditEntryNotFoundError,
			'unknown audit entry should throw AuditEntryNotFoundError',
		)
		console.log(
			`   Caught AuditEntryNotFoundError: ${(revertErr as Error).message}`,
		)

		// ── 4. Catching any pg-history error ─────────────────
		console.log('\n4. Using the base PgHistoryError class...')

		const baseErr = await assertThrows(
			() => history.search({ tables: ['nonexistent'] }),
			(e) => e instanceof PgHistoryError,
			'every pg-history error extends PgHistoryError',
		)
		console.log(
			`   Caught PgHistoryError (${(baseErr as Error).constructor.name}): ${(baseErr as Error).message}`,
		)

		// ── 5. Invalid operation validation ──────────────────
		console.log('\n5. Passing an invalid operation to search...')

		const opErr = await assertThrows(
			() =>
				history.search({
					tables: ['users'],
					// @ts-expect-error intentionally passing an operation that is not audited
					operation: 'MERGE',
				}),
			(e) => e instanceof Error && e.message.includes('Invalid operation'),
			'an unknown operation should be rejected',
		)
		console.log(`   Caught Error: ${(opErr as Error).message}`)

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

run(main)
