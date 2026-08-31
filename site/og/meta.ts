/**
 * The head of index.html, filled in at build time.
 *
 * index.html ships with placeholder values — an empty description, a bare
 * title, and the card at its unhashed URL — and this rewrites them from the
 * README and the rendered card. Keeping the rewrite here rather than inline in
 * vite.config.ts is what makes it testable: the tags and the patterns that
 * find them are one contract, and `test/social-card.test.ts` fails the build
 * the moment a tag is renamed out from under a pattern. Silence is the whole
 * risk — a missed substitution ships a card that says nothing, and no build
 * error, no failing page and no browser complains about it.
 *
 * Dependency-free on purpose: the test suite imports it from the repo root,
 * where `site/`'s own dependencies are not installed.
 */

/**
 * 1200x630 is the size both LinkedIn and X document, and the one every other
 * unfurler falls back to. It is declared in index.html and rendered by
 * og/card.ts, which both read it from here — the platforms drop cards whose
 * declared dimensions disagree with the file.
 */
export const CARD_WIDTH = 1200
export const CARD_HEIGHT = 630

/**
 * The card URL as index.html carries it, before the build swaps in the
 * content-hashed name. Absolute because LinkedIn ignores relative URLs, and it
 * stays a real reachable path because the build emits the card under this name
 * too — anything that linked to it before the hash existed still resolves.
 */
export const CARD_PLACEHOLDER_URL = 'https://pg-chronicle.com/og.png'

export type PageMeta = {
	title: string
	description: string
	/** Absolute URL of the rendered card, content-hashed. */
	cardUrl: string
}

/**
 * Every tag this fills, paired with the pattern that finds it. Written out
 * rather than derived so that adding a tag to index.html without teaching the
 * build about it is a visible omission rather than a silent one.
 */
const FIELDS: ReadonlyArray<{
	pattern: RegExp
	value: (meta: PageMeta) => string
}> = [
	{ pattern: /(<title>)[^<]*/, value: (m) => m.title },
	{
		pattern: /(name="description" content=")[^"]*/,
		value: (m) => m.description,
	},
	{ pattern: /(property="og:title" content=")[^"]*/, value: (m) => m.title },
	{ pattern: /(name="twitter:title" content=")[^"]*/, value: (m) => m.title },
	{
		pattern: /(property="og:description" content=")[^"]*/,
		value: (m) => m.description,
	},
	{
		pattern: /(name="twitter:description" content=")[^"]*/,
		value: (m) => m.description,
	},
]

/** Fills the head's placeholders. Throws rather than shipping a half-filled head. */
export function withPageMeta(html: string, meta: PageMeta): string {
	let out = html
	for (const field of FIELDS) {
		if (!field.pattern.test(out)) {
			throw new Error(`index.html has no tag matching ${field.pattern}`)
		}
		out = out.replace(field.pattern, `$1${field.value(meta)}`)
	}

	// Every declaration of the card — og:image, its secure twin and
	// twitter:image — moves to the hashed URL together. A card whose tags
	// disagree about its own image is one an unfurler is free to resolve either
	// way, and X resolves it to the stale one it already has.
	const url = out.split(CARD_PLACEHOLDER_URL).length - 1
	if (url < 3) {
		throw new Error(
			`index.html declares the card ${url} times, expected og:image, og:image:secure_url and twitter:image`,
		)
	}
	return out.replaceAll(CARD_PLACEHOLDER_URL, meta.cardUrl)
}
