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
	const sql = await getTestConnection()
	const result = await sql`SELECT 1 as value`
	expect(result[0]?.value).toBe(1)
})
