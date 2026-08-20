/**
 * Umami analytics, injected into index.html at build time.
 *
 * Entirely optional: without `UMAMI_WEBSITE_ID` in the build environment the
 * page ships exactly as it did before — no tag, no request, no cookie. That is
 * what keeps a fork or a local `bun run build` from reporting into someone
 * else's dashboard.
 */

/** Where the tracker is served from when the environment does not say. */
export const DEFAULT_UMAMI_SCRIPT_URL =
	'https://linesofcode-umami.vercel.app/script.js'

/** Umami identifies each site by a UUID; anything else is a typo, not a site. */
const WEBSITE_ID =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface AnalyticsEnv {
	/** Umami website UUID. Absent or blank disables analytics entirely. */
	UMAMI_WEBSITE_ID?: string
	/** Full URL of the tracker script, for a self-hosted Umami elsewhere. */
	UMAMI_SCRIPT_URL?: string
}

/**
 * Builds the `<script>` tag for a build environment, or `''` when analytics
 * are not configured.
 *
 * @throws if the id or URL is present but malformed — a silent skip there would
 * look identical to "not configured" and the deploy would go out untracked.
 */
export function umamiScriptTag(env: AnalyticsEnv): string {
	const websiteId = env.UMAMI_WEBSITE_ID?.trim()
	if (!websiteId) return ''

	if (!WEBSITE_ID.test(websiteId)) {
		throw new Error(
			`UMAMI_WEBSITE_ID must be a UUID, got ${JSON.stringify(websiteId)}`,
		)
	}

	const src = env.UMAMI_SCRIPT_URL?.trim() || DEFAULT_UMAMI_SCRIPT_URL
	let url: URL
	try {
		url = new URL(src)
	} catch {
		throw new Error(`UMAMI_SCRIPT_URL must be an absolute URL, got ${src}`)
	}
	if (url.protocol !== 'https:') {
		throw new Error(`UMAMI_SCRIPT_URL must be https, got ${src}`)
	}

	return `<script defer src="${url.href}" data-website-id="${websiteId}"></script>`
}
