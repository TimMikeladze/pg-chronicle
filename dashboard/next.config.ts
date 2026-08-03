import path from 'node:path'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
	/*
	 * `pg` and `pghistory` must stay in Node's require graph rather than being
	 * bundled: pg loads native/optional drivers by dynamic require, and
	 * pghistory's archiver pulls in the S3 + Parquet libraries the same way.
	 * Bundling them produces "Module not found" at build time.
	 */
	serverExternalPackages: ['pg', 'pghistory'],

	/*
	 * pghistory is symlinked from the parent directory, so its real sources live
	 * above this one. Without an explicit tracing root Next infers it from the
	 * nearest lockfile and warns (or drops the package from the bundle).
	 */
	outputFileTracingRoot: path.join(import.meta.dirname, '..'),

	/*
	 * `serverExternalPackages` alone does not catch pghistory here: it is a
	 * symlink out of node_modules, so Next's "is this a package?" heuristic
	 * misses it. Webpack then walks into
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
					if (request === 'pghistory' || request?.startsWith('pghistory/')) {
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
