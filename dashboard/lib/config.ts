/**
 * Reads the same environment variables the pg-chronicle server itself reads, so
 * the dashboard never maintains a second source of truth for which tables are
 * audited or whether the archiver exists.
 *
 * Safe to import from client components: it exposes only non-secret config, and
 * the values are passed down from server components as props.
 */

export interface DashboardConfig {
	/** Tables the API will accept — mirrors PG_CHRONICLE_TABLES. */
	tables: string[]
	/** True when PG_CHRONICLE_S3_BUCKET is set; archiver routes exist only then. */
	archiverEnabled: boolean
	/** Identity written into the JWT `sub`, which pg-chronicle logs on every revert. */
	actor: string
}

export function readConfig(): DashboardConfig {
	const tables = (process.env.PG_CHRONICLE_TABLES ?? '')
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean)

	const archiverEnabled = Boolean(process.env.PG_CHRONICLE_S3_BUCKET)

	return {
		tables,
		archiverEnabled,
		actor: process.env.PG_CHRONICLE_DASHBOARD_ACTOR?.trim() || 'dashboard',
	}
}
