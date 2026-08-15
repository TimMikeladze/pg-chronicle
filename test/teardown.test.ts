import { beforeEach, describe, expect, test } from 'bun:test'
import { PgChronicle } from '../src'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgChronicle.teardown', () => {
	beforeEach(async () => {
		const pool = await getTestConnection()
		await pool.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      )
    `)
	})

	test('should remove all audit infrastructure', async () => {
		const pool = await getTestConnection()
		const audit = new PgChronicle({ pool, tables: ['users'] })
		await audit.setup()

		// Verify setup worked
		const tables = await pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename LIKE 'audit%'
    `)
		expect(tables.rows.length).toBeGreaterThan(0)

		// Teardown
		await audit.teardown()

		// Verify cleanup
		const remaining = await pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename LIKE 'audit%'
    `)
		expect(remaining.rows.length).toBe(0)
	})

	test('should remove triggers from tables', async () => {
		const pool = await getTestConnection()
		const audit = new PgChronicle({ pool, tables: ['users'] })
		await audit.setup()

		// Verify trigger exists
		const triggers = await pool.query(`
      SELECT tgname FROM pg_trigger
      WHERE tgname = 'audit_trigger_users'
    `)
		expect(triggers.rows.length).toBe(1)

		// Teardown
		await audit.teardown()

		// Verify trigger removed
		const remaining = await pool.query(`
      SELECT tgname FROM pg_trigger
      WHERE tgname = 'audit_trigger_users'
    `)
		expect(remaining.rows.length).toBe(0)
	})

	test('should be idempotent - running twice works', async () => {
		const pool = await getTestConnection()
		const audit = new PgChronicle({ pool, tables: ['users'] })
		await audit.setup()

		await audit.teardown()
		await audit.teardown() // Should not error

		const tables = await pool.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename LIKE 'audit%'
    `)
		expect(tables.rows.length).toBe(0)
	})
})
