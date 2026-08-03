import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
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
 */
function prerenderReadme(): Plugin {
	return {
		name: 'pghistory:prerender-readme',
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
		},
		async generateBundle() {
			this.emitFile({
				type: 'asset',
				fileName: 'llms.txt',
				source: await renderLlmsTxt(siteDir),
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
