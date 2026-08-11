import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import { renderCard } from './og/card'
import { renderLlmsTxt, renderPage } from './prerender'

const siteDir = import.meta.dirname
const repoRoot = path.resolve(siteDir, '..')
const sources = [
	path.join(repoRoot, 'README.md'),
	path.join(repoRoot, 'package.json'),
]

/**
 * Renders the README into index.html at build time, so the browser gets static
 * markup and never downloads a markdown parser or a syntax highlighter.
 *
 * The same pass emits /llms.txt and /og.png — both are derived from the README,
 * so generating them here is what keeps them from drifting out of step with the
 * page. Nothing about the card is committed: change the tagline and the next
 * deploy carries it onto every social share.
 */
function prerenderReadme(): Plugin {
	return {
		name: 'pg-history:prerender-readme',
		async transformIndexHtml(html) {
			const page = await renderPage(siteDir)
			return html
				.replace('<!--app-html-->', page.html)
				.replace(/<title>.*?<\/title>/, `<title>${page.title}</title>`)
				.replace(/(name="description" content=")[^"]*/, `$1${page.description}`)
				.replace(/(property="og:title" content=")[^"]*/, `$1${page.title}`)
				.replace(
					/(property="og:description" content=")[^"]*/,
					`$1${page.description}`,
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
			// tool points at a 404 while developing.
			server.middlewares.use('/og.png', async (_req, res) => {
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
			this.emitFile({
				type: 'asset',
				fileName: 'og.png',
				source: await renderCard(siteDir),
			})
		},
	}
}

export default defineConfig({
	plugins: [prerenderReadme()],
	build: {
		target: 'es2022',
	},
})
