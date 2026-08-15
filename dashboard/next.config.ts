import { existsSync } from 'node:fs'
import path from 'node:path'
import type { NextConfig } from 'next'

/*
 * Two ways this app resolves `pg-chronicle`, and they need different tracing
 * roots:
 *
 *   in-repo    node_modules/pg-chronicle is a symlink to the repo root (see the
 *              repo README), so the real sources live one level up.
 *   standalone deployed on its own — the Vercel deploy button clones only this
 *              directory — where `pg-chronicle` is an ordinary npm dependency and
 *              there is no parent package at all.
 *
 * Pointing the tracing root above a standalone deployment would put it outside
 * the deployment, so decide by looking for the parent package.
 */
const repoRoot = path.join(import.meta.dirname, '..')
const inRepo = existsSync(path.join(repoRoot, 'package.json'))

const nextConfig: NextConfig = {
	/*
	 * `pg` and `pg-chronicle` must stay in Node's require graph rather than being
	 * bundled: pg loads native/optional drivers by dynamic require, and
	 * pg-chronicle's archiver pulls in the S3 + Parquet libraries the same way.
	 * Bundling them produces "Module not found" at build time.
	 */
	serverExternalPackages: ['pg', 'pg-chronicle'],

	/*
	 * In-repo, pg-chronicle is symlinked from the parent directory, so its real
	 * sources live above this one. Without an explicit tracing root Next infers
	 * it from the nearest lockfile and warns (or drops the package from the
	 * bundle).
	 */
	outputFileTracingRoot: inRepo ? repoRoot : import.meta.dirname,

	/*
	 * `serverExternalPackages` alone does not catch pg-chronicle here: it is a
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
					if (
						request === 'pg-chronicle' ||
						request?.startsWith('pg-chronicle/')
					) {
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
