import 'server-only'

/**
 * A tiny read-through cache for the read-only search probes the server
 * components use to render feeds.
 *
 * Why this exists: `PgChronicle.search()` caps concurrent searches (default 4)
 * and rejects the excess with 429 — a deliberate DoS guard, since an unindexed
 * ILIKE scan pins a pool connection for seconds. That cap is shared by the
 * whole process, so several dashboard pages rendering at once will starve each
 * other and degrade to "unavailable" banners under perfectly ordinary load.
 *
 * Two mechanisms, both of which matter:
 *
 * - `inflight` coalesces a simultaneous burst onto ONE query. Without it, ten
 *   concurrent renders of the same page start ten searches and seven get a 429.
 * - `ttlMs` reuses the result for a few seconds afterwards. Feeds are
 *   navigational: seconds of staleness are invisible, whereas spending a search
 *   slot per page view is not.
 *
 * Deliberately module-level and in-process: this is a warm-instance
 * optimisation, not a correctness mechanism, and losing it on a cold start
 * costs nothing. Failures are never cached — a degraded read must be retried
 * on the next request, not pinned for the whole TTL.
 */
interface Entry<T> {
	at: number
	value: T
}

const cache = new Map<string, Entry<unknown>>()
const inflight = new Map<string, Promise<unknown>>()

/** Bounds memory if a caller ever generates unbounded keys. */
const MAX_ENTRIES = 64

export async function cachedProbe<T>(
	key: string,
	ttlMs: number,
	load: () => Promise<T>,
	/**
	 * Returns true when the result represents a failed read. Failures bypass the
	 * cache so the next request retries instead of serving a stale error.
	 */
	isFailure: (value: T) => boolean = () => false,
): Promise<T> {
	const hit = cache.get(key) as Entry<T> | undefined
	if (hit && Date.now() - hit.at < ttlMs) return hit.value

	const pending = inflight.get(key) as Promise<T> | undefined
	if (pending) return pending

	const promise = load()
		.then((value) => {
			if (!isFailure(value)) {
				if (cache.size >= MAX_ENTRIES) {
					// Map preserves insertion order — evict the oldest.
					const oldest = cache.keys().next().value
					if (oldest !== undefined) cache.delete(oldest)
				}
				cache.set(key, { at: Date.now(), value })
			}
			return value
		})
		.finally(() => {
			inflight.delete(key)
		})

	inflight.set(key, promise)
	return promise
}
