import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { umamiScriptTag } from './analytics'
import { renderCard, socialCard } from './og/card'
import { withPageMeta } from './og/meta'
import { renderLlmsTxt, renderPage } from './prerender'

const siteDir = import.meta.dirname
const repoRoot = path.resolve(siteDir, '..')
const sources = [
	path.join(repoRoot, 'README.md'),
	path.join(repoRoot, 'package.json'),
]

/**
 * Where the card is fetched from. Absolute because LinkedIn ignores relative
 * URLs, and the site's own origin because a card served from anywhere else is
 * one more thing that can 404 in a feed.
 */
const SITE_ORIGIN = 'https://pg-chronicle.com'

/**
 * Renders the README into index.html at build time, so the browser gets static
 * markup and never downloads a markdown parser or a syntax highlighter.
 *
 * The same pass emits /llms.txt and the social card — both are derived from the
 * README, so generating them here is what keeps them from drifting out of step
 * with the page. Nothing about the card is committed: change the tagline and
 * the next deploy carries it onto every social share, under a new URL that no
 * unfurler has a stale copy of.
 */
function prerenderReadme(): Plugin {
	return {
		name: 'pg-chronicle:prerender-readme',
		async transformIndexHtml(html) {
			const [page, card] = await Promise.all([
				renderPage(siteDir),
				socialCard(siteDir),
			])
			return withPageMeta(
				html
					.replace('<!--analytics-->', umamiScriptTag(process.env))
					.replace('<!--app-html-->', page.html),
				{
					title: page.title,
					description: page.description,
					cardUrl: `${SITE_ORIGIN}/${card.fileName}`,
				},
			)
		},
		configureServer(server) {
			// Editing the README reloads the dev page.
			server.watcher.add(sources)
			server.watcher.on('change', (file) => {
				if (sources.includes(file)) {
					server.ws.send({ type: 'full-reload' })
				}
			})
			server.middlewares.use('/llms.txt', async (_req, res) => {
				res.setHeader('Content-Type', 'text/plain; charset=utf-8')
				res.end(await renderLlmsTxt(siteDir))
			})
			// The social card is emitted into the bundle, not into public/, so
			// dev has to serve it the same way — otherwise every card preview
			// tool points at a 404 while developing. Served under any of its
			// names: the meta tags carry the hashed one, and /og.png is what
			// anything written by hand reaches for.
			server.middlewares.use(async (req, res, next) => {
				if (!/^\/og(-[0-9a-f]+)?\.png(\?|$)/.test(req.url ?? '')) return next()
				res.setHeader('Content-Type', 'image/png')
				res.end(await renderCard(siteDir))
			})
		},
		async generateBundle() {
			this.emitFile({
				type: 'asset',
				fileName: 'llms.txt',
				source: await renderLlmsTxt(siteDir),
			})
			// Both names, one render: the hashed one the meta tags point at, and
			// /og.png for anything already linking to it — a README, an old
			// post, a card some platform cached before the hash existed.
			const card = await socialCard(siteDir)
			for (const fileName of [card.fileName, 'og.png']) {
				this.emitFile({ type: 'asset', fileName, source: card.png })
			}
		},
	}
}

export default defineConfig({
	plugins: [prerenderReadme()],
	build: {
		target: 'es2022',
	},
})
