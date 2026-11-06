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
	 * Turbopack's project root has to contain every file it compiles, and
	 * in-repo that includes the symlinked library one level up.
	 */
	turbopack: { root: inRepo ? repoRoot : import.meta.dirname },
}

export default nextConfig
