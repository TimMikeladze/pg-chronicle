/**
 * The one-click deploy URL, in one place.
 *
 * Three surfaces render this link — the README badge, the site's hero button
 * and the site's deploy card — and a hand-copied query string drifts the
 * moment a variable is added. `test/deploy-button.test.ts` fails the build if
 * the README's copy stops matching what this file builds.
 *
 * Dependency-free on purpose: the test suite imports it from the repo root,
 * where `site/`'s own dependencies are not installed.
 */

const REPO = 'https://github.com/TimMikeladze/pg-chronicle'

/**
 * The four the clone form cannot fill in for anyone: a connection string, the
 * tables to audit, a JWT signing secret and the dashboard password. A default
 * for any of these would end up in the deploy URL, and from there in browser
 * history — the same reason Vercel refuses values in the `env` parameter.
 *
 * `PG_CHRONICLE_DASHBOARD_PASSWORD` is here rather than under the optional
 * group because without it the deployed dashboard refuses to serve any page in
 * production — reaching one grants full audit read plus revert, so the gate
 * fails closed.
 */
export const DEPLOY_ENV_REQUIRED = [
	'PG_CHRONICLE_DATABASE_URL',
	'PG_CHRONICLE_TABLES',
	'PG_CHRONICLE_JWT_SECRET',
	'PG_CHRONICLE_DASHBOARD_PASSWORD',
] as const

/**
 * S3 archival and its cron trigger. Every one of these is safe to leave blank:
 * the library reads them for truthiness (`enableArchiver: !!PG_CHRONICLE_S3_BUCKET`,
 * `CRON_SECRET?.trim() || undefined`), so an empty value is the same as an
 * unset one — the dashboard deploys without the archival panels and the daily
 * cron in `dashboard/vercel.json` finds no `/api/archive` to call.
 *
 * They are listed anyway because the alternative is a cloned project whose
 * shipped cron entry can never work until someone reads the README, and adding
 * them later means a second deploy.
 */
export const DEPLOY_ENV_OPTIONAL = [
	'PG_CHRONICLE_S3_BUCKET',
	'PG_CHRONICLE_S3_ACCESS_KEY_ID',
	'PG_CHRONICLE_S3_SECRET_ACCESS_KEY',
	'CRON_SECRET',
] as const

/**
 * The library defaults, prefilled so the form is a review rather than a
 * lookup. Non-secret every one of them — Vercel stores `envDefaults` in the
 * URL, so anything here is public.
 *
 * `PG_CHRONICLE_S3_REGION` sits with the defaults rather than the optional
 * group: it is prefilled like the rest, and idle until a bucket is set. Keep
 * this list in step with the README's Environment Variables table.
 */
export const DEPLOY_ENV_DEFAULTS = {
	PG_CHRONICLE_S3_REGION: 'us-east-1',
	PG_CHRONICLE_JWT_ALG: 'HS256',
	PG_CHRONICLE_POOL_MAX: '3',
	PG_CHRONICLE_STATEMENT_TIMEOUT_MS: '30000',
	PG_CHRONICLE_DASHBOARD_ACTOR: 'dashboard',
	PG_CHRONICLE_RETENTION_DAYS: '90',
	PG_CHRONICLE_GRACE_PERIOD_DAYS: '7',
	PG_CHRONICLE_BATCH_SIZE: '10000',
} as const

/**
 * Vercel renders one description above the whole form, so the required/optional
 * split has to be spelled out here — the form itself marks every listed key the
 * same way.
 */
const ENV_DESCRIPTION = [
	'Four need a value: PG_CHRONICLE_DATABASE_URL, PG_CHRONICLE_TABLES, PG_CHRONICLE_JWT_SECRET,',
	'and PG_CHRONICLE_DASHBOARD_PASSWORD (the UI can read and revert every audited record).',
	'Optional — leave blank to deploy without S3 archival: PG_CHRONICLE_S3_BUCKET,',
	'PG_CHRONICLE_S3_ACCESS_KEY_ID, PG_CHRONICLE_S3_SECRET_ACCESS_KEY, CRON_SECRET.',
	'Everything else arrives prefilled with the library defaults and can be left as is.',
].join(' ')

/** Every key the clone form shows, in the order it shows them. */
export const DEPLOY_ENV = [
	...DEPLOY_ENV_REQUIRED,
	...DEPLOY_ENV_OPTIONAL,
	...Object.keys(DEPLOY_ENV_DEFAULTS),
]

/**
 * The button clones `dashboard/` on its own — the UI plus the REST API it is
 * built on, with archival driven by Vercel Cron.
 */
export const VERCEL_DEPLOY_URL = `https://vercel.com/new/clone?${new URLSearchParams(
	{
		'repository-url': `${REPO}/tree/main/dashboard`,
		'project-name': 'pg-chronicle-dashboard',
		'repository-name': 'pg-chronicle-dashboard',
		env: DEPLOY_ENV.join(','),
		envDefaults: JSON.stringify(DEPLOY_ENV_DEFAULTS),
		envDescription: ENV_DESCRIPTION,
		envLink: `${REPO}#environment-variables`,
	},
).toString()}`
