/**
 * Generates the social card at site/public/og.png — the image LinkedIn, X,
 * Slack and iMessage show when the site is shared.
 *
 * It is a build artifact that is committed, not built on deploy: rendering it
 * needs a headless Chrome, which the Vercel build does not have. Re-run it
 * (`bun run og` from site/) whenever the tagline, the pitch or the dashboard
 * screenshots change, and commit the result.
 *
 * Everything the card says comes from the README or from prerender.ts, so the
 * card cannot drift from the page it advertises.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const siteDir = path.resolve(import.meta.dirname, '..')
const repoRoot = path.resolve(siteDir, '..')

/**
 * 1200x630 is the size both LinkedIn and X document, and the one every other
 * unfurler falls back to. Rendered at 2x and downsampled so the 16px type in
 * the screenshot survives.
 */
const WIDTH = 1200
const HEIGHT = 630
const SCALE = 2

const CHROME =
	process.env.CHROME_PATH ??
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/** The dark Explore screenshot — the same file the hero shows. */
const SHOT = path.join(siteDir, 'public/shots/explore-dark.png')

function dataUri(file: string, mime: string) {
	return `data:${mime};base64,${readFileSync(file).toString('base64')}`
}

function font(pkg: string, file: string) {
	return dataUri(
		path.join(siteDir, 'node_modules/@fontsource', pkg, 'files', file),
		'font/woff2',
	)
}

/** The tagline, verbatim from the README's first line of prose. */
function readTagline() {
	const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8')
	const tagline = readme
		.split(/\r?\n/)
		.slice(1)
		.find((line) => line.trim() && !line.startsWith('['))
	return (
		tagline?.trim() ?? 'PostgreSQL audit trails with automated S3 archival.'
	)
}

/**
 * The card's own copy. Short enough to read at feed size — a LinkedIn card is
 * about 550px wide in the timeline, so everything here is sized to survive a
 * halving.
 *
 * The three operations carry the dashboard's own colours, which is the whole
 * colour vocabulary of the product: green inserts, amber updates, red deletes.
 * Anyone who clicks through meets the same three again in the table rows.
 */
const EYEBROW = 'POSTGRESQL · APPEND-ONLY AUDIT LOG'
const PITCH = `Every <b style="color:#3dd68c">INSERT</b>, <b style="color:#f5a623">UPDATE</b> and <b style="color:#ff6166">DELETE</b> recorded in the same transaction as the write. Browse, search and revert it from the dashboard.`

function html() {
	const sans400 = font('geist-sans', 'geist-sans-latin-400-normal.woff2')
	const sans500 = font('geist-sans', 'geist-sans-latin-500-normal.woff2')
	const sans600 = font('geist-sans', 'geist-sans-latin-600-normal.woff2')
	const mono400 = font('geist-mono', 'geist-mono-latin-400-normal.woff2')
	const mono500 = font('geist-mono', 'geist-mono-latin-500-normal.woff2')
	const shot = dataUri(SHOT, 'image/png')

	return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
@font-face { font-family: Geist; src: url('${sans400}') format('woff2'); font-weight: 400 }
@font-face { font-family: Geist; src: url('${sans500}') format('woff2'); font-weight: 500 }
@font-face { font-family: Geist; src: url('${sans600}') format('woff2'); font-weight: 600 }
@font-face { font-family: 'Geist Mono'; src: url('${mono400}') format('woff2'); font-weight: 400 }
@font-face { font-family: 'Geist Mono'; src: url('${mono500}') format('woff2'); font-weight: 500 }

* { box-sizing: border-box; margin: 0; padding: 0 }

body {
	width: ${WIDTH}px;
	height: ${HEIGHT}px;
	overflow: hidden;
	position: relative;
	background: #0a0a0a;
	color: #ededed;
	font-family: Geist, sans-serif;
	-webkit-font-smoothing: antialiased;
}

/* The hero's own backdrop: a hairline grid, faded out to the right so the
   screenshot sits on plain black rather than on ruled paper. */
.rules {
	position: absolute; inset: 0;
	background-image:
		linear-gradient(to right, #1f1f1f 1px, transparent 1px),
		linear-gradient(to bottom, #1f1f1f 1px, transparent 1px);
	background-size: 48px 48px;
	-webkit-mask-image: radial-gradient(120% 90% at 0% 0%, #000 0%, transparent 62%);
	opacity: 0.55;
}

.copy {
	position: absolute;
	left: 64px; top: 50%;
	transform: translateY(-50%);
	width: 548px;
	z-index: 2;
}

.brand { display: flex; align-items: center; gap: 11px; margin-bottom: 30px }
.brand svg { width: 24px; height: 24px; color: #ffffff }
.brand-name {
	font-family: 'Geist Mono', monospace;
	font-weight: 500;
	font-size: 23px;
	letter-spacing: -0.01em;
	color: #ffffff;
}

.eyebrow {
	display: flex; align-items: center; gap: 10px;
	font-family: 'Geist Mono', monospace;
	font-size: 14px;
	letter-spacing: 0.09em;
	color: #8f8f8f;
	margin-bottom: 18px;
}
.dot { width: 7px; height: 7px; border-radius: 50%; background: #3dd68c }

h1 {
	font-size: 42px;
	line-height: 1.1;
	font-weight: 600;
	letter-spacing: -0.033em;
	color: #ffffff;
	margin-bottom: 20px;
}

.pitch {
	font-size: 23px;
	line-height: 1.5;
	color: #b5b5b5;
	letter-spacing: -0.008em;
}
.pitch b {
	font-family: 'Geist Mono', monospace;
	font-weight: 500;
	font-size: 20px;
}

.install {
	display: inline-flex; align-items: center; gap: 11px;
	margin-top: 34px;
	font-family: 'Geist Mono', monospace;
	font-size: 20px;
	color: #ededed;
	padding: 12px 18px;
	border: 1px solid #2e2e2e;
	border-radius: 10px;
	background: #0f0f0f;
	z-index: 2;
}
.install .prompt { color: #8f8f8f }

/* The screenshot, in a window that runs off the right and bottom edges — the
   card is a crop of a real dashboard, not a shrunk-to-fit thumbnail, so the
   rows and their operation badges stay legible at feed size. */
.window {
	position: absolute;
	left: 660px; top: 88px;
	width: 700px; height: 542px;
	border: 1px solid #2e2e2e;
	border-radius: 12px 0 0 0;
	overflow: hidden;
	background: #0a0a0a;
	box-shadow: -40px 0 90px -30px rgba(0, 0, 0, 0.9);
	z-index: 1;
}
.window img {
	/* Logical width of the capture is 1400px; 940 shows the left two thirds. */
	width: 940px;
	display: block;
}

/* Keeps the left column readable where the window would otherwise crowd it. */
.fade {
	position: absolute;
	left: 548px; top: 0; width: 140px; height: 100%;
	background: linear-gradient(to right, #0a0a0a 20%, transparent);
	z-index: 1;
}
</style>
</head>
<body>
	<div class="rules"></div>
	<div class="window"><img src="${shot}" alt="" /></div>
	<div class="fade"></div>

	<div class="copy">
		<div class="brand">
			<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
				<path d="M3 4h6M3 8h10M3 12h7" />
			</svg>
			<span class="brand-name">pg-history</span>
		</div>
		<p class="eyebrow"><span class="dot"></span>${EYEBROW}</p>
		<h1>${readTagline().replace(/\.$/, '')}</h1>
		<p class="pitch">${PITCH}</p>
		<div class="install"><span class="prompt">$</span>bun add pg-history</div>
	</div>

</body>
</html>`
}

function main() {
	const work = mkdtempSync(path.join(tmpdir(), 'pg-history-og-'))
	const page = path.join(work, 'og.html')
	writeFileSync(page, html())

	// Chrome writes the capture and then sits there rather than exiting, so this
	// is bounded by a timeout and judged on whether the file appeared, not on
	// the exit status.
	const capture = path.join(work, 'og@2x.png')
	spawnSync(
		CHROME,
		[
			'--headless=new',
			'--disable-gpu',
			'--no-first-run',
			'--no-default-browser-check',
			'--hide-scrollbars',
			'--virtual-time-budget=4000',
			`--force-device-scale-factor=${SCALE}`,
			`--window-size=${WIDTH},${HEIGHT}`,
			`--screenshot=${capture}`,
			`--user-data-dir=${path.join(work, 'chrome')}`,
			`file://${page}`,
		],
		{ stdio: 'inherit', timeout: 60_000 },
	)
	if (!existsSync(capture)) {
		throw new Error(`Chrome wrote no capture. Set CHROME_PATH? (${CHROME})`)
	}

	// Downsample the 2x capture to the documented card size: sharper small type
	// than rendering at 1x, and a third of the bytes of shipping the 2x.
	const out = path.join(siteDir, 'public/og.png')
	const sips = spawnSync(
		'sips',
		[
			'-s',
			'format',
			'png',
			'-z',
			String(HEIGHT),
			String(WIDTH),
			path.join(work, 'og@2x.png'),
			'--out',
			out,
		],
		{ stdio: 'inherit' },
	)
	if (sips.status !== 0) throw new Error(`sips exited with ${sips.status}`)

	console.log(`wrote ${path.relative(repoRoot, out)}`)
}

main()
