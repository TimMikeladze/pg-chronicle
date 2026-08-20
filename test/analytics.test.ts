import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_UMAMI_SCRIPT_URL, umamiScriptTag } from '../site/analytics'

const ID = 'd963c774-d848-46d1-88e9-a76185dc47a8'

const INDEX_HTML = readFileSync(
	path.join(import.meta.dir, '..', 'site', 'index.html'),
	'utf8',
)

/**
 * Analytics are opt-in through the build environment, which means the failure
 * mode nobody notices is the tag silently going missing on a real deploy. These
 * tests pin both directions: nothing without the variable, a well-formed tag
 * with it.
 */
describe('umami script tag', () => {
	it('emits nothing when the website id is absent or blank', () => {
		expect(umamiScriptTag({})).toBe('')
		expect(umamiScriptTag({ UMAMI_WEBSITE_ID: '   ' })).toBe('')
	})

	it('points at the default tracker when only the id is set', () => {
		const tag = umamiScriptTag({ UMAMI_WEBSITE_ID: ID })
		expect(tag).toBe(
			`<script defer src="${DEFAULT_UMAMI_SCRIPT_URL}" data-website-id="${ID}"></script>`,
		)
	})

	it('honours a self-hosted tracker URL', () => {
		const tag = umamiScriptTag({
			UMAMI_WEBSITE_ID: ID,
			UMAMI_SCRIPT_URL: 'https://analytics.example.com/umami.js',
		})
		expect(tag).toContain('src="https://analytics.example.com/umami.js"')
	})

	it('rejects a malformed id rather than deploying untracked', () => {
		expect(() => umamiScriptTag({ UMAMI_WEBSITE_ID: 'not-a-uuid' })).toThrow(
			/must be a UUID/,
		)
	})

	it('rejects a tracker URL that is not absolute https', () => {
		for (const UMAMI_SCRIPT_URL of ['/script.js', 'http://example.com/s.js']) {
			expect(() =>
				umamiScriptTag({ UMAMI_WEBSITE_ID: ID, UMAMI_SCRIPT_URL }),
			).toThrow(/UMAMI_SCRIPT_URL/)
		}
	})

	it('leaves a placeholder in index.html for the build to replace', () => {
		expect(INDEX_HTML).toContain('<!--analytics-->')
	})
})
