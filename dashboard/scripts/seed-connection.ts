/**
 * Seeds one connection into the registry, for CI's access-gate check.
 *
 * It goes through the registry's own `createConnection` rather than writing SQL
 * by hand, so the schema and the sealed-credential format under test can never
 * drift from what the application writes. `server-only` throws outside a Next
 * build, hence `bun --preload ./lib/test-setup.ts`.
 *
 * Usage: bun --preload ./lib/test-setup.ts scripts/seed-connection.ts <name> <table>
 */
import { createConnection, DuplicateConnectionError } from '../lib/registry'

const url = process.env.PG_CHRONICLE_DASHBOARD_DATABASE_URL
if (!url) {
	console.error('PG_CHRONICLE_DASHBOARD_DATABASE_URL is required')
	process.exit(1)
}

const name = process.argv[2] ?? 'CI'
const table = process.argv[3] ?? 'users'

try {
	const connection = await createConnection({
		name,
		// The registry database stands in for a managed one here; nothing about
		// the gate depends on them being different.
		databaseUrl: url,
		tables: [table],
		archiver: null,
	})
	console.log(`seeded connection ${connection.id}`)
} catch (error) {
	if (!(error instanceof DuplicateConnectionError)) throw error
	console.log(`connection ${name} already exists`)
}

// The registry pool keeps the loop alive; this is a one-shot script.
process.exit(0)
