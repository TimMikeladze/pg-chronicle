/**
 * Captures the dashboard screenshots the landing page and the social card use.
 *
 * The shots are real captures of the running dashboard rather than mockups,
 * which is the point: what the page promises is what the product looks like.
 * Reproducing them takes two steps —
 *
 *   bun run site/shots/seed.ts 'postgres://…/pg_chronicle_shots'
 *   cd dashboard && PG_CHRONICLE_DATABASE_URL='postgres://…/pg_chronicle_shots' \
 *     PG_CHRONICLE_TABLES='users,orders,invoices,api_keys' bun run dev --port 3111
 *   bun run site/shots/capture.ts            # writes site/public/shots/*.png
 *
 * Chrome does the rendering: this drives the copy already installed on the
 * machine (override with CHROME_PATH) through puppeteer-core, so nothing
 * downloads a second browser. Every shot is taken in both themes because the
 * page shows whichever matches the visitor's — a light screenshot must never
 * land on a dark page.
 */
import path from 'node:path'
import puppeteer from 'puppeteer-core'

const BASE = process.env.SHOTS_BASE_URL ?? 'http://localhost:3111'
const OUT = path.resolve(import.meta.dirname, '../public/shots')

const CHROME =
	process.env.CHROME_PATH ??
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

/**
 * 1400x900 at 2x. The hero displays the shots at 1400 CSS pixels wide, so
 * this is exactly 2x the display size — capturing wider would shrink the
 * dashboard's own type into mush on the page.
 */
const WIDTH = 1400
const HEIGHT = 900
const SCALE = 2

/**
 * `expand` clicks the "Show changes" disclosures it names, by index down the
 * page: the timeline collapses entries by default, which is right for the app
 * and useless in a screenshot, where a collapsed diff shows that something
 * changed without showing what.
 *
 * `submit` presses a button by its label and waits for the result. Explore
 * deliberately runs nothing until asked, so without this the shot is of an
 * empty results panel.
 */
const SHOTS = [
	{
		name: 'timeline',
		url: '/history/users/usr_8f2a1c',
		expand: [0, 1],
	},
	{
		name: 'explore',
		url: '/search?tables=users,orders,invoices,api_keys',
		submit: 'Search',
	},
	{ name: 'tables', url: '/tables' },
] as const

const browser = await puppeteer.launch({
	executablePath: CHROME,
	headless: true,
	defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: SCALE },
})

try {
	for (const shot of SHOTS) {
		for (const theme of ['light', 'dark'] as const) {
			const page = await browser.newPage()
			// next-themes reads this before first paint, so setting it up front
			// avoids capturing a frame of the wrong theme.
			await page.evaluateOnNewDocument((value) => {
				localStorage.setItem('theme', value)
			}, theme)
			await page.emulateMediaFeatures([
				{ name: 'prefers-color-scheme', value: theme },
			])

			await page.goto(`${BASE}${shot.url}`, { waitUntil: 'networkidle0' })
			// Next's dev-mode indicator floats over the bottom-left corner of
			// every page and would end up in every screenshot.
			await page.addStyleTag({
				content: 'nextjs-portal { display: none !important }',
			})

			if ('submit' in shot) {
				const buttons = await page.$$('button')
				const labels = await Promise.all(
					buttons.map((b) => b.evaluate((el) => el.textContent?.trim() ?? '')),
				)
				// The label carries a keyboard hint next to the word, and the
				// header has its own button with the same word in it — so match
				// loosely and take the last one, which is the form's.
				const index = labels.findLastIndex((label) =>
					label.includes(shot.submit),
				)
				const button = buttons[index]
				if (!button) throw new Error(`${shot.name}: no "${shot.submit}" button`)
				await button.click()
				await page.waitForNetworkIdle()
			}

			for (const index of 'expand' in shot ? shot.expand : []) {
				const buttons = await page.$$('button')
				const labels = await Promise.all(
					buttons.map((b) => b.evaluate((el) => el.textContent?.trim() ?? '')),
				)
				const targets = buttons.filter(
					(_, i) =>
						labels[i] === 'Show changes' || labels[i] === 'Hide changes',
				)
				const target = targets[index]
				if (!target) throw new Error(`${shot.name}: no disclosure #${index}`)
				const label = await target.evaluate((el) => el.textContent?.trim())
				if (label === 'Show changes') await target.click()
			}
			// Clicking a disclosure scrolls it into view, which would capture the
			// page mid-scroll with its heading off the top.
			await page.evaluate(() => window.scrollTo(0, 0))
			// The disclosures animate open; capture once they have settled.
			await new Promise((resolve) => setTimeout(resolve, 600))

			const file = path.join(OUT, `${shot.name}-${theme}.png`)
			await page.screenshot({ path: file })
			console.log(`wrote ${path.relative(process.cwd(), file)}`)
			await page.close()
		}
	}
} finally {
	await browser.close()
}
