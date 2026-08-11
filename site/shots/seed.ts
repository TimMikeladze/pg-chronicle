/**
 * Seeds the database the marketing screenshots are taken against.
 *
 * The shots have to show the product doing its actual job, so this is not
 * lorem ipsum: it is a small SaaS account whose history reads like something
 * that really happened — a signup, a support correction, a nightly job
 * suspending an account, a human putting it back. Every row here exists to
 * make one thing visible in a screenshot: several changed columns in a single
 * diff, distinct actors, all three operations, and timestamps far enough apart
 * that the relative times ("2 weeks ago") differ down the page.
 *
 *   bun run site/shots/seed.ts 'postgres://.../pg_history_shots'
 *
 * Destructive: it drops and recreates its four tables and the audit log every
 * time, so a re-run always produces the same screenshots. Point it at a
 * scratch database, never at anything real.
 */
import { Pool } from 'pg'
import { PgHistory } from '../../src/PgHistory'

const TABLES = ['users', 'orders', 'invoices', 'api_keys']

const url = process.argv[2] ?? process.env.PG_HISTORY_DATABASE_URL
if (!url) throw new Error('usage: bun run site/shots/seed.ts <database-url>')

const pool = new Pool({ connectionString: url })

/**
 * One write, attributed. `pg_history.actor` has to be set in the same
 * transaction as the write for the trigger to record it — which is the point
 * the screenshots are there to make, so the seed does it the honest way rather
 * than by writing audit rows directly.
 */
async function write(actor: string, sql: string, params: unknown[] = []) {
	const client = await pool.connect()
	try {
		await client.query('BEGIN')
		await client.query('SELECT set_config($1, $2, true)', [
			'pg_history.actor',
			actor,
		])
		await client.query(sql, params)
		await client.query('COMMIT')
	} catch (error) {
		await client.query('ROLLBACK')
		throw error
	} finally {
		client.release()
	}
}

/**
 * Ages the trail. The trigger stamps `now()`, so a freshly seeded database
 * shows a wall of "a few seconds ago" — useless in a screenshot, where the
 * spread of times is what says "this is a history". Entries are backdated in
 * the order they were written, oldest first.
 */
async function backdate(daysAgo: number[]) {
	const { rows } = await pool.query<{ id: string }>(
		'SELECT id FROM audit_log ORDER BY id',
	)
	if (rows.length !== daysAgo.length) {
		throw new Error(
			`backdate: ${rows.length} audit entries but ${daysAgo.length} offsets`,
		)
	}
	for (const [i, row] of rows.entries()) {
		await pool.query(
			`UPDATE audit_log SET changed_at = now() - ($1 || ' days')::interval WHERE id = $2`,
			[daysAgo[i], row.id],
		)
	}
}

async function main() {
	await pool.query(`
		DROP TABLE IF EXISTS audit_log CASCADE;
		DROP TABLE IF EXISTS users, orders, invoices, api_keys CASCADE;

		CREATE TABLE users (
			-- A string primary key, the way most SaaS schemas actually look. It
			-- also gives the record page a heading worth reading: "usr_8f2a1c"
			-- says what the row is, where a bare "1" says nothing.
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			email TEXT NOT NULL,
			plan TEXT NOT NULL,
			seats INT NOT NULL,
			status TEXT NOT NULL
		);
		CREATE TABLE orders (
			id BIGSERIAL PRIMARY KEY,
			customer TEXT NOT NULL,
			total_cents INT NOT NULL,
			currency TEXT NOT NULL,
			status TEXT NOT NULL
		);
		CREATE TABLE invoices (
			id BIGSERIAL PRIMARY KEY,
			customer TEXT NOT NULL,
			amount_cents INT NOT NULL,
			status TEXT NOT NULL,
			due_on DATE NOT NULL
		);
		CREATE TABLE api_keys (
			id BIGSERIAL PRIMARY KEY,
			label TEXT NOT NULL,
			scope TEXT NOT NULL,
			owner TEXT NOT NULL,
			revoked BOOLEAN NOT NULL DEFAULT false
		);
	`)

	const history = new PgHistory({ pool, tables: TABLES })
	await history.setup()

	// users/usr_8f2a1c — the record the hero screenshot follows. Read top to bottom it
	// is a support story: someone signs up, a typo in the email is fixed, the
	// account is upgraded, a nightly job suspends it over a failed payment, and
	// support puts it back. Each update touches more than one column, so the
	// expanded diffs in the shot have something to show.
	await write(
		'signup@pg-history.dev',
		`INSERT INTO users (id, name, email, plan, seats, status)
		 VALUES ('usr_8f2a1c', 'Alice Nguyen', 'alice@exmaple.com', 'free', 1, 'active')`,
	)
	await write(
		'support@example.com',
		`UPDATE users SET email = 'alice@example.com' WHERE id = 'usr_8f2a1c'`,
	)
	await write(
		'alice@example.com',
		`UPDATE users SET plan = 'pro', seats = 12 WHERE id = 'usr_8f2a1c'`,
	)
	await write(
		'batch@nightly-sync',
		`UPDATE users SET status = 'suspended' WHERE id = 'usr_8f2a1c'`,
	)
	await write(
		'support@example.com',
		`UPDATE users SET status = 'active', plan = 'enterprise', seats = 40
		 WHERE id = 'usr_8f2a1c'`,
	)

	// The rest of the account: enough breadth that the tables and search
	// screens have all three operations and four distinct actors in them.
	await write(
		'api@checkout-service',
		`INSERT INTO orders (customer, total_cents, currency, status)
		 VALUES ('Acme Corp', 129900, 'usd', 'pending'),
		        ('Globex', 24900, 'usd', 'pending')`,
	)
	await write(
		'api@checkout-service',
		`UPDATE orders SET status = 'paid' WHERE id = 1`,
	)
	await write('alice@example.com', `DELETE FROM orders WHERE id = 2`)

	await write(
		'billing@nightly-sync',
		`INSERT INTO invoices (customer, amount_cents, status, due_on)
		 VALUES ('Acme Corp', 129900, 'open', now() + interval '30 days'),
		        ('Globex', 24900, 'open', now() + interval '14 days')`,
	)
	await write(
		'billing@nightly-sync',
		`UPDATE invoices SET status = 'paid' WHERE id = 1`,
	)

	await write(
		'alice@example.com',
		`INSERT INTO api_keys (label, scope, owner)
		 VALUES ('production', 'read_write', 'alice@example.com'),
		        ('ci', 'read_only', 'batch@nightly-sync'),
		        ('staging', 'read_write', 'alice@example.com')`,
	)
	await write(
		'support@example.com',
		`UPDATE api_keys SET revoked = true, scope = 'read_only' WHERE id = 3`,
	)
	await write('batch@nightly-sync', `DELETE FROM api_keys WHERE id = 2`)

	// Oldest first, in the order the writes above ran — one offset per audit
	// entry, so a statement touching three rows needs three. The user record
	// spans three weeks, which is what makes its timeline read in weeks, days and
	// hours rather than as one clump of "a few seconds ago".
	await backdate([
		// the user: signup, the email fix, the upgrade, the suspension, the fix
		23, 21, 16, 6, 2,
		// orders: two placed, one paid, one deleted
		19, 19, 18, 11,
		// invoices: two raised, one paid
		19, 19, 12,
		// api_keys: three issued, one revoked, one deleted
		22, 22, 22, 4, 0.3,
	])

	const { rows } = await pool.query<{ n: string }>(
		'SELECT count(*) AS n FROM audit_log',
	)
	console.log(
		`seeded ${rows[0]?.n} audit entries across ${TABLES.length} tables`,
	)
	await pool.end()
}

main()
