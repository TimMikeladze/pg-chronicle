/**
 * Reads the same environment variables the pghistory server itself reads, so
 * the dashboard never maintains a second source of truth for which tables are
 * audited or whether the archiver exists.
 *
 * Safe to import from client components: it exposes only non-secret config, and
 * the values are passed down from server components as props.
 */

export interface DashboardConfig {
	/** Tables the API will accept — mirrors PGHISTORY_TABLES. */
	tables: string[]
	/** True when PGHISTORY_S3_BUCKET is set; archiver routes exist only then. */
	archiverEnabled: boolean
	/**
	 * Whether `POST /api/archive` is reachable from this dashboard.
	 *
	 * When CRON_SECRET is set, that endpoint requires the Authorization header to
	 * be exactly `Bearer <CRON_SECRET>` — but the `/api/*` JWT middleware runs
	 * first and rejects anything that isn't a valid token. One header cannot be
	 * both, so a JWT caller cannot reach the route at all. The dashboard always
	 * runs with a JWT secret (pghistory/next refuses to start without one), so
	 * setting CRON_SECRET makes on-demand archival scheduler-only by design.
	 */
	archiveTriggerAvailable: boolean
	/** Identity written into the JWT `sub`, which pghistory logs on every revert. */
	actor: string
}

export function readConfig(): DashboardConfig {
	const tables = (process.env.PGHISTORY_TABLES ?? '')
		.split(',')
		.map((t) => t.trim())
		.filter(Boolean)

	const archiverEnabled = Boolean(process.env.PGHISTORY_S3_BUCKET)

	return {
		tables,
		archiverEnabled,
		archiveTriggerAvailable:
			archiverEnabled && !process.env.CRON_SECRET?.trim(),
		actor: process.env.PGHISTORY_DASHBOARD_ACTOR?.trim() || 'dashboard',
	}
}
