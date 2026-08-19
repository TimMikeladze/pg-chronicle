import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
	DEPLOY_ENV,
	DEPLOY_ENV_DEFAULTS,
	DEPLOY_ENV_OPTIONAL,
	DEPLOY_ENV_REQUIRED,
	VERCEL_DEPLOY_URL,
} from '../site/deploy'

const README = readFileSync(
	path.join(import.meta.dir, '..', 'README.md'),
	'utf8',
)

/**
 * The deploy button lives in three places — the README badge (twice) and the
 * site, which imports the URL directly. Only the README can drift, because its
 * copy is a literal query string; these tests are what stops it.
 */
describe('one-click deploy button', () => {
	it('every README badge points at the generated URL', () => {
		const urls = README.match(/https:\/\/vercel\.com\/new\/clone\?[^)]+/g) ?? []
		expect(urls.length).toBeGreaterThan(0)
		for (const url of urls) {
			expect(url).toBe(VERCEL_DEPLOY_URL)
		}
	})

	it('documents every variable the clone form asks for', () => {
		for (const key of DEPLOY_ENV) {
			expect(README).toContain(`\`${key}\``)
		}
	})

	it('prefills defaults only for keys the form actually shows', () => {
		for (const key of Object.keys(DEPLOY_ENV_DEFAULTS)) {
			expect(DEPLOY_ENV).toContain(key)
		}
	})

	/**
	 * A default lands in the URL, and from there in browser history. The four
	 * values a deployer has to type are exactly the ones that must never.
	 */
	it('never prefills a required (secret) variable', () => {
		for (const key of DEPLOY_ENV_REQUIRED) {
			expect(DEPLOY_ENV_DEFAULTS).not.toHaveProperty(key)
		}
	})

	/**
	 * Vercel renders one description above the whole form and marks every listed
	 * key alike, so the only place the optional ones can be flagged as optional
	 * is that text. If a key is added to the group without being named there, a
	 * deployer has no way to know they can skip it.
	 */
	it('names every optional variable in the form description', () => {
		const description = new URL(VERCEL_DEPLOY_URL).searchParams.get(
			'envDescription',
		)
		expect(description).toContain('leave blank')
		for (const key of DEPLOY_ENV_OPTIONAL) {
			expect(description).toContain(key)
		}
	})
})
