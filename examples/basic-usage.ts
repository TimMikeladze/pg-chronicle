import { PgHistory } from '../src'

async function main() {
	// Initialize history tracking
	const history = new PgHistory({
		connection: process.env.DATABASE_URL || 'postgres://localhost:5432/test',
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
