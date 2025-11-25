import { Client } from 'pg'
import { PgHistory } from '../src'

async function createDatabaseIfNotExists(connectionString: string) {
	// Parse the connection string to extract database name
	const url = new URL(connectionString)
	const targetDb = url.pathname.slice(1) || 'test'

	// Connect to the default 'postgres' database to check/create our target database
	const adminUrl = new URL(connectionString)
	adminUrl.pathname = '/postgres'

	const adminClient = new Client({ connectionString: adminUrl.toString() })

	try {
		await adminClient.connect()

		// Check if database exists
		const result = await adminClient.query(
			'SELECT 1 FROM pg_database WHERE datname = $1',
			[targetDb],
		)

		if (result.rowCount === 0) {
			// Database doesn't exist, create it
			console.log(`Creating database '${targetDb}'...`)
			await adminClient.query(`CREATE DATABASE "${targetDb}"`)
			console.log(`Database '${targetDb}' created successfully`)
		} else {
			console.log(`Database '${targetDb}' already exists`)
		}
	} finally {
		await adminClient.end()
	}
}

async function main() {
	// Generate a random database name
	const randomDbName = `pg_history_test_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`

	const connectionString =
		process.env.DATABASE_URL || `postgres://localhost:5432/${randomDbName}`

	console.log(`Using database: ${randomDbName}`)

	// Create database if it doesn't exist
	await createDatabaseIfNotExists(connectionString)

	// Initialize history tracking
	const history = new PgHistory({
		connection: connectionString,
		tables: ['users', 'orders'],
	})

	try {
		// Setup history tracking infrastructure
		console.log('Setting up history tracking...')
		await history.setup()

		// Your application makes database changes
		// These are automatically captured by triggers
		console.log('Changes are now being tracked automatically')

		// Set user context (optional)
		await history.setUser('admin-123', {
			ip: '192.168.1.1',
			action: 'api_call',
			requestId: 'req-456',
		})

		// Query history for a record
		const recordHistory = await history.getHistory('users', '1')
		console.log('History:', recordHistory.data)

		// Search across all tracked changes
		const searchResults = await history.search({
			tables: ['users', 'orders'],
			query: 'alice',
			dateFrom: new Date('2024-01-01'),
		})
		console.log('Search results:', searchResults.data)

		// Revert to previous version
		if (recordHistory.data[1]) {
			await history.revert('users', '1', recordHistory.data[1].id)
			console.log('Reverted to previous version')
		}
	} finally {
		await history.close()
	}
}

main().catch(console.error)
