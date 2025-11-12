import { beforeEach, describe, expect, test } from 'bun:test'
import { PgHistory } from '../src'
import { getTestConnection, setupTestDatabase } from './helpers'

setupTestDatabase()

describe('PgHistory.teardown', () => {
	beforeEach(async () => {
		const sql = await getTestConnection()
		await sql`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT
      )
    `
	})

	test('should remove all audit infrastructure', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		// Verify setup worked
		const tables = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename LIKE 'audit%'
    `
		expect(tables.length).toBeGreaterThan(0)

		// Teardown
		await audit.teardown()

		// Verify cleanup
		const remaining = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename LIKE 'audit%'
    `
		expect(remaining.length).toBe(0)
	})

	test('should remove triggers from tables', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		// Verify trigger exists
		const triggers = await sql`
      SELECT tgname FROM pg_trigger
      WHERE tgname = 'audit_trigger_users'
    `
		expect(triggers.length).toBe(1)

		// Teardown
		await audit.teardown()

		// Verify trigger removed
		const remaining = await sql`
      SELECT tgname FROM pg_trigger
      WHERE tgname = 'audit_trigger_users'
    `
		expect(remaining.length).toBe(0)
	})

	test('should be idempotent - running twice works', async () => {
		const sql = await getTestConnection()
		const audit = new PgHistory({ sql, tables: ['users'] })
		await audit.setup()

		await audit.teardown()
		await audit.teardown() // Should not error

		const tables = await sql`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename LIKE 'audit%'
    `
		expect(tables.length).toBe(0)
	})
})
