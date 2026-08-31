import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
	CARD_HEIGHT,
	CARD_PLACEHOLDER_URL,
	CARD_WIDTH,
	withPageMeta,
} from '../site/og/meta'

const INDEX_HTML = readFileSync(
	path.join(import.meta.dir, '..', 'site', 'index.html'),
	'utf8',
)

const META = {
	title: 'pg-chronicle — PostgreSQL audit trails with automated S3 archival',
	description: 'PostgreSQL audit trails with automated S3 archival.',
	cardUrl: 'https://pg-chronicle.com/og-0123456789.png',
}

/**
 * The social card's failure mode is silence. A tag renamed in index.html, or a
 * card URL left at its placeholder, produces a page that builds, renders and
 * serves exactly as before — the only symptom is a bare link in someone else's
 * feed, days later, cached by a platform that will not re-fetch it. These pin
 * the contract between the markup and the build.
 */
describe('page meta', () => {
	const filled = withPageMeta(INDEX_HTML, META)

	it('fills every title and description, page and social', () => {
		expect(filled).toContain(`<title>${META.title}</title>`)
		for (const attr of ['property="og:title"', 'name="twitter:title"']) {
			expect(filled).toContain(`${attr} content="${META.title}"`)
		}
		for (const attr of [
			'name="description"',
			'property="og:description"',
			'name="twitter:description"',
		]) {
			expect(filled).toContain(`${attr} content="${META.description}"`)
		}
		// Nothing left at its placeholder. The card's own alt text is the one
		// tag index.html ships filled in, so an empty content= is a miss.
		expect(filled).not.toContain('content="" />')
	})

	it('moves every declaration of the card to the hashed URL', () => {
		expect(filled).not.toContain(CARD_PLACEHOLDER_URL)
		// og:image, og:image:secure_url and twitter:image.
		expect(filled.split(META.cardUrl)).toHaveLength(4)
	})

	it('refuses a head it cannot fill rather than shipping a blank card', () => {
		expect(() => withPageMeta('<html><head></head></html>', META)).toThrow()
		expect(() =>
			withPageMeta(INDEX_HTML.replace(CARD_PLACEHOLDER_URL, '/og.png'), META),
		).toThrow(/declares the card 2 times/)
	})
})

/**
 * X and LinkedIn drop a card whose declared dimensions disagree with the file,
 * and X falls back to a small summary card when the large-image type is not
 * spelled out — a fallback it then caches for days.
 */
describe('card declaration', () => {
	it('declares the size the card is actually rendered at', () => {
		expect(INDEX_HTML).toContain(
			`property="og:image:width" content="${CARD_WIDTH}"`,
		)
		expect(INDEX_HTML).toContain(
			`property="og:image:height" content="${CARD_HEIGHT}"`,
		)
	})

	it('asks for the large-image card and describes it', () => {
		expect(INDEX_HTML).toContain(
			'name="twitter:card" content="summary_large_image"',
		)
		expect(INDEX_HTML).toContain('property="og:image:alt"')
		expect(INDEX_HTML).toContain('name="twitter:image:alt"')
	})

	it('points at the card absolutely, as LinkedIn requires', () => {
		expect(CARD_PLACEHOLDER_URL.startsWith('https://')).toBe(true)
	})
})
