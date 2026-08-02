import path from 'node:path'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
	/*
	 * `pg` and `pg-history` must stay in Node's require graph rather than being
	 * bundled: pg loads native/optional drivers by dynamic require, and
	 * pg-history's archiver pulls in the S3 + Parquet libraries the same way.
	 * Bundling them produces "Module not found" at build time.
	 */
	serverExternalPackages: ['pg', 'pg-history'],

	/*
	 * pg-history is linked with `file:..`, so the real sources live above this
	 * directory. Without an explicit tracing root Next infers it from the nearest
	 * lockfile and warns (or, on Vercel, drops the package from the bundle).
	 */
	outputFileTracingRoot: path.join(import.meta.dirname, '..'),

	/*
	 * `serverExternalPackages` alone does not catch pg-history here: it is linked
	 * with `file:..`, so it resolves to a path outside node_modules and Next's
	 * "is this a package?" heuristic misses it. Webpack then walks into
	 * hono-openapi and reports a missing `zod/v4/core` — an optional adapter that
	 * is never reached at runtime, but a "Module not found" line in every build.
	 *
	 * Marking it external keeps the whole library (including the S3 and Parquet
	 * archiver) in Node's own require graph, where it belongs.
	 */
	webpack: (config, { isServer }) => {
		if (isServer) {
			config.externals = [
				...(Array.isArray(config.externals) ? config.externals : []),
				({ request }: { request?: string }, callback: ExternalCallback) => {
					if (request === 'pg-history' || request?.startsWith('pg-history/')) {
						return callback(undefined, `module ${request}`)
					}
					callback()
				},
			]
		}
		return config
	},
}

type ExternalCallback = (error?: unknown, result?: string) => void

export default nextConfig
