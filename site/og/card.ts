/**
 * The social card — the 1200x630 image LinkedIn, X, Slack and iMessage show
 * when the site is shared.
 *
 * It is drawn here rather than exported from a design tool so that it is built
 * from the same README the page is built from: change the tagline and the next
 * deploy carries it. Satori lays the card out and resvg rasterises it, both in
 * plain JavaScript — a headless browser would be the obvious way to render HTML
 * to a PNG, but the deploy has no browser, and a committed PNG would go stale
 * the first time the README changed.
 *
 * See vite.config.ts, which emits this at /og.png in dev and in the bundle.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { initWasm, Resvg } from '@resvg/resvg-wasm'
import satori from 'satori'

/**
 * 1200x630 is the size both LinkedIn and X document, and the one every other
 * unfurler falls back to. Declared in index.html too — the platforms drop cards
 * whose declared dimensions disagree with the file.
 */
export const CARD_WIDTH = 1200
export const CARD_HEIGHT = 630

/**
 * The screen the card shows, from the same set as the hero — the record
 * timeline, because a before/after diff with an actor against it says what the
 * library does in the half-second a feed gets looked at.
 */
const SHOT = 'public/shots/timeline-dark.png'

/**
 * The card's own copy. Sized to survive a halving: a card is about 550px wide
 * in a LinkedIn feed, so anything that has to be read there is at least 20px
 * here.
 *
 * The three operations wear the dashboard's own colours, which are the entire
 * colour vocabulary of the product — green inserts, amber updates, red deletes.
 * Whoever clicks through meets the same three again in the table rows.
 */
const EYEBROW = 'POSTGRESQL · APPEND-ONLY AUDIT LOG'
const INSTALL = 'bun add pg-history'
const OP_INSERT = '#3dd68c'
const OP_UPDATE = '#f5a623'
const OP_DELETE = '#ff6166'

const BG = '#0a0a0a'
const BORDER = '#2e2e2e'
const DIM = '#8f8f8f'

/** The tagline, verbatim from the README's first line of prose. */
function readTagline(readme: string) {
	const tagline = readme
		.split(/\r?\n/)
		.slice(1)
		.find((line) => line.trim() && !line.startsWith('['))
	return (
		tagline?.trim() ?? 'PostgreSQL audit trails with automated S3 archival.'
	)
}

/**
 * Satori takes React elements, but only reads `type`/`props` off them — so the
 * card is written as plain objects and the site keeps its zero-dependency,
 * no-JSX build.
 */
type Node = {
	type: string
	props: Record<string, unknown> & { children?: unknown }
}

function el(
	type: string,
	props: Record<string, unknown>,
	...children: unknown[]
): Node {
	return {
		type,
		props: {
			...props,
			...(children.length
				? { children: children.length === 1 ? children[0] : children }
				: {}),
		},
	}
}

/** Satori needs woff/ttf/otf — the woff2 files @fontsource ships are not read. */
async function loadFont(siteDir: string, pkg: string, file: string) {
	return readFile(
		path.join(siteDir, 'node_modules/@fontsource', pkg, 'files', file),
	)
}

async function dataUri(file: string, mime: string) {
	return `data:${mime};base64,${(await readFile(file)).toString('base64')}`
}

/** A word in the pitch, in the colour the dashboard gives that operation. */
function op(label: string, color: string) {
	return el(
		'span',
		{
			style: {
				marginRight: 8,
				fontFamily: 'Geist Mono',
				fontWeight: 500,
				fontSize: 20,
				color,
			},
		},
		label,
	)
}

function card(tagline: string, shot: string): Node {
	return el(
		'div',
		{
			style: {
				width: CARD_WIDTH,
				height: CARD_HEIGHT,
				display: 'flex',
				position: 'relative',
				background: BG,
				fontFamily: 'Geist',
				color: '#ededed',
			},
		},
		// A hairline grid behind the copy, fading out before it reaches the
		// screenshot — the same backdrop the page's own hero sits on.
		el('div', {
			style: {
				position: 'absolute',
				top: 0,
				left: 0,
				width: 700,
				height: 380,
				backgroundImage:
					'linear-gradient(to right, #1f1f1f 1px, transparent 1px), linear-gradient(to bottom, #1f1f1f 1px, transparent 1px)',
				backgroundSize: '48px 48px, 48px 48px',
				opacity: 0.5,
			},
		}),
		el('div', {
			style: {
				position: 'absolute',
				top: 0,
				left: 0,
				width: 700,
				height: 380,
				backgroundImage: `radial-gradient(120% 90% at 0% 0%, rgba(10,10,10,0) 0%, ${BG} 62%)`,
			},
		}),

		// The screenshot, in a window that runs off the right and bottom edges.
		// The card is a crop of a real dashboard rather than a shrunk-to-fit
		// thumbnail, so its rows and operation badges stay legible at feed size.
		el(
			'div',
			{
				style: {
					position: 'absolute',
					top: 104,
					left: 660,
					width: 700,
					height: 526,
					display: 'flex',
					overflow: 'hidden',
					borderTop: `1px solid ${BORDER}`,
					borderLeft: `1px solid ${BORDER}`,
					borderTopLeftRadius: 12,
					background: BG,
				},
			},
			// The capture is 1400x900 in CSS pixels. Only 540 of this window's
			// 700px sit on the canvas — the rest hangs off the right edge — so
			// the scale is set by what has to survive that crop: both columns
			// of the before/after diff, which is the whole reason this screen
			// is the one on the card.
			el('img', {
				src: shot,
				width: 850,
				height: 546,
				style: { marginLeft: -6 },
			}),
		),
		// Keeps the copy readable where the window would otherwise crowd it.
		el('div', {
			style: {
				position: 'absolute',
				top: 0,
				left: 548,
				width: 140,
				height: CARD_HEIGHT,
				backgroundImage: `linear-gradient(to right, ${BG} 20%, rgba(10,10,10,0))`,
			},
		}),

		el(
			'div',
			{
				style: {
					position: 'absolute',
					top: 0,
					left: 64,
					width: 548,
					height: CARD_HEIGHT,
					display: 'flex',
					flexDirection: 'column',
					justifyContent: 'center',
				},
			},
			el(
				'div',
				{ style: { display: 'flex', alignItems: 'center', marginBottom: 30 } },
				// The dashboard's mark: three bars of unequal length, shortest
				// first — three audit entries stacked in time.
				el('img', {
					src: `data:image/svg+xml;base64,${Buffer.from(
						`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"><path d="M3 4h6M3 8h10M3 12h7"/></svg>`,
					).toString('base64')}`,
					width: 24,
					height: 24,
				}),
				el(
					'span',
					{
						style: {
							marginLeft: 11,
							fontFamily: 'Geist Mono',
							fontWeight: 500,
							fontSize: 23,
							letterSpacing: '-0.01em',
							color: '#ffffff',
						},
					},
					'pg-history',
				),
			),
			el(
				'div',
				{ style: { display: 'flex', alignItems: 'center', marginBottom: 18 } },
				el('div', {
					style: {
						width: 7,
						height: 7,
						marginRight: 10,
						borderRadius: 4,
						background: OP_INSERT,
					},
				}),
				el(
					'span',
					{
						style: {
							fontFamily: 'Geist Mono',
							fontSize: 14,
							letterSpacing: '0.09em',
							color: DIM,
						},
					},
					EYEBROW,
				),
			),
			el(
				'div',
				{
					style: {
						marginBottom: 20,
						fontSize: 42,
						fontWeight: 600,
						lineHeight: 1.1,
						letterSpacing: '-0.033em',
						color: '#ffffff',
					},
				},
				tagline.replace(/\.$/, ''),
			),
			// Two explicit rows rather than one wrapping paragraph: Satori lays
			// text out as flex items, not as an inline flow, so a paragraph with
			// coloured words inside it breaks in places prose never would.
			el(
				'div',
				{
					style: {
						display: 'flex',
						alignItems: 'baseline',
						fontSize: 23,
						letterSpacing: '-0.008em',
						color: '#b5b5b5',
					},
				},
				el('span', { style: { marginRight: 8 } }, 'Every'),
				op('INSERT,', OP_INSERT),
				op('UPDATE', OP_UPDATE),
				el('span', { style: { marginRight: 8 } }, 'and'),
				op('DELETE', OP_DELETE),
			),
			el(
				'div',
				{
					style: {
						marginTop: 6,
						fontSize: 23,
						lineHeight: 1.45,
						letterSpacing: '-0.008em',
						color: '#b5b5b5',
					},
				},
				'recorded in the same transaction as the write. Browse, search and revert it from the dashboard.',
			),
			el(
				'div',
				{
					style: {
						display: 'flex',
						alignItems: 'center',
						alignSelf: 'flex-start',
						marginTop: 34,
						padding: '12px 18px',
						border: `1px solid ${BORDER}`,
						borderRadius: 10,
						background: '#0f0f0f',
						fontFamily: 'Geist Mono',
						fontSize: 20,
						color: '#ededed',
					},
				},
				el('span', { style: { marginRight: 11, color: DIM } }, '$'),
				INSTALL,
			),
		),
	)
}

/** resvg's wasm module is global and initialises once per process. */
let wasmReady: Promise<unknown> | undefined

/** Renders the card to PNG bytes. */
export async function renderCard(siteDir: string): Promise<Buffer> {
	const repoRoot = path.resolve(siteDir, '..')
	const [readme, shot, sans400, sans600, mono400, mono500] = await Promise.all([
		readFile(path.join(repoRoot, 'README.md'), 'utf8'),
		dataUri(path.join(siteDir, SHOT), 'image/png'),
		loadFont(siteDir, 'geist-sans', 'geist-sans-latin-400-normal.woff'),
		loadFont(siteDir, 'geist-sans', 'geist-sans-latin-600-normal.woff'),
		loadFont(siteDir, 'geist-mono', 'geist-mono-latin-400-normal.woff'),
		loadFont(siteDir, 'geist-mono', 'geist-mono-latin-500-normal.woff'),
	])

	const svg = await satori(card(readTagline(readme), shot) as never, {
		width: CARD_WIDTH,
		height: CARD_HEIGHT,
		fonts: [
			{ name: 'Geist', data: sans400, weight: 400, style: 'normal' },
			{ name: 'Geist', data: sans600, weight: 600, style: 'normal' },
			{ name: 'Geist Mono', data: mono400, weight: 400, style: 'normal' },
			{ name: 'Geist Mono', data: mono500, weight: 500, style: 'normal' },
		],
	})

	if (!wasmReady) {
		wasmReady = initWasm(
			readFile(
				path.join(siteDir, 'node_modules/@resvg/resvg-wasm/index_bg.wasm'),
			),
		)
	}
	await wasmReady

	return Buffer.from(
		new Resvg(svg, {
			fitTo: { mode: 'width', value: CARD_WIDTH },
			background: BG,
		})
			.render()
			.asPng(),
	)
}
