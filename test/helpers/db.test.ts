import { afterAll, beforeAll, expect, test } from 'bun:test'
import {
	closeTestConnection,
	createTestDatabase,
	dropTestDatabase,
	getTestConnection,
} from './db'

beforeAll(async () => {
	await createTestDatabase()
})

afterAll(async () => {
	await closeTestConnection()
	await dropTestDatabase()
})

test('should create and connect to test database', async () => {
	const pool = await getTestConnection()
	const result = await pool.query(`SELECT 1 as value`)
	expect(result.rows[0]?.value).toBe(1)
})
