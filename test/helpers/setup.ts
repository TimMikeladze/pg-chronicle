import { afterAll, beforeAll, beforeEach } from 'bun:test'
import {
	cleanDatabase,
	closeTestConnection,
	createTestDatabase,
	dropTestDatabase,
} from './db'

export function setupTestDatabase(): void {
	beforeAll(async () => {
		await createTestDatabase()
	})

	afterAll(async () => {
		await closeTestConnection()
		await dropTestDatabase()
	})

	beforeEach(async () => {
		await cleanDatabase()
	})
}
