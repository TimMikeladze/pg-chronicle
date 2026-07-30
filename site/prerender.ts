import { readFile } from 'node:fs/promises'
import path from 'node:path'
import bash from '@shikijs/langs/bash'
import json from '@shikijs/langs/json'
import sql from '@shikijs/langs/sql'
import typescript from '@shikijs/langs/typescript'
import vitesseDark from '@shikijs/themes/vitesse-dark'
import vitesseLight from '@shikijs/themes/vitesse-light'
import { Marked } from 'marked'
import { createHighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'

const REPO = 'https://github.com/TimMikeladze/pg-history'
const NPM = 'https://www.npmjs.com/package/pg-history'

/** Title + tagline for the hero, so the README stays the only source of truth. */
function readHero(md: string) {
	const title = /^#\s+(.+)$/m.exec(md)?.[1] ?? 'pg-history'
	const tagline = md
		.split(/\r?\n/)
		.slice(1)
		.find((l) => l.trim() && !l.startsWith('['))
	const pkg =
		/```bash\nbun add ([^\n]+)\n```/.exec(md)?.[1] ?? 'pg-history'
	const install = {
		bun: `bun add ${pkg}`,
		npm: `npm install ${pkg}`,
		pnpm: `pnpm add ${pkg}`,
	}
	return { title, tagline: tagline?.trim() ?? '', install }
}

/**
 * Drop the leading title/tagline/badges and the README's own Table of Contents
 * — the hero and the generated section grid cover those — and point
 * repo-relative links at GitHub so they resolve off-repo.
 */
function prepareBody(md: string) {
	const tocIndex = md.indexOf('## Table of Contents')
	const afterToc = md.indexOf('\n## ', tocIndex + 1)
	const body = tocIndex === -1 || afterToc === -1 ? md : md.slice(afterToc + 1)
	return body.replace(/\]\(\.\/([^)]+)\)/g, `](${REPO}/blob/main/$1)`)
}

/** The section list the README itself curates, in its order. */
function parseToc(md: string) {
	const start = md.indexOf('## Table of Contents')
	if (start === -1) return []
	const end = md.indexOf('\n## ', start + 1)
	const block = md.slice(start, end === -1 ? undefined : end)
	return [...block.matchAll(/^-\s*\[([^\]]+)\]\(#([^)]+)\)/gm)].map((m) => ({
		text: m[1] ?? '',
		anchor: m[2] ?? '',
	}))
}

/**
 * The intro prose sitting directly under each `##`, before any `###`. Used as
 * the section-grid descriptions, so the cards stay in sync with the docs.
 */
function sectionIntros(md: string) {
	const lines = md.split(/\r?\n/)
	const marks: { line: number; slug: string }[] = []
	lines.forEach((line, i) => {
		if (line.startsWith('## ')) {
			marks.push({ line: i, slug: slugify(line.slice(3).trim()) })
		}
	})

	const intros = new Map<string, string>()
	marks.forEach(({ line, slug }, i) => {
		const end = marks[i + 1]?.line ?? lines.length
		const paragraphs: string[] = []
		let inFence = false
		for (const raw of lines.slice(line + 1, end)) {
			const s = raw.trim()
			if (s.startsWith('```')) {
				inFence = !inFence
				continue
			}
			if (inFence) continue
			if (s.startsWith('###')) break
			// Skip tables, lists, quotes and badge rows — not descriptive prose.
			if (!s || /^[|\-*>]/.test(s)) continue
			paragraphs.push(s)
			if (paragraphs.join(' ').length > 200) break
		}
		const intro = summarise(paragraphs.join(' '))
		if (intro) intros.set(slug, intro)
	})
	return intros
}

/** First sentence or two of a paragraph, flattened to plain text. */
function summarise(text: string) {
	const plain = text
		.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their label
		.replace(/\*\*([^*]+)\*\*/g, '$1') // bold only; bare _ and * are identifiers
		.replace(/`/g, '')
		.trim()
	if (!plain) return ''

	// Split only where a terminator is followed by a capital, so "Node.js" and
	// "Fly.io" survive intact.
	const sentences = plain.split(/(?<=[.!?])\s+(?=[A-Z])/)
	let out = ''
	for (const sentence of sentences) {
		out = out ? `${out} ${sentence}` : sentence
		if (out.length >= 60) break
	}
	out = out.trim().replace(/:$/, '.')
	if (out.length <= 165) return out
	const cut = out.slice(0, 165)
	return `${cut.slice(0, cut.lastIndexOf(' ')).replace(/[,;:]$/, '')}…`
}

/** GitHub's heading slug algorithm, so the README's own TOC anchors resolve. */
function slugify(text: string) {
	return text
		.toLowerCase()
		.trim()
		.replace(/[^\w\- ]+/g, '')
		.replace(/ /g, '-')
}

function escapeHtml(value: string) {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
}

export interface RenderedPage {
	html: string
	title: string
	description: string
}

/**
 * llms.txt (see llmstxt.org): a plain-text map of the docs for LLMs to read
 * instead of scraping the rendered page. Built from the same README sections
 * as the on-page section grid, so the two stay in sync.
 */
export async function renderLlmsTxt(siteDir: string): Promise<string> {
	const repoRoot = path.resolve(siteDir, '..')
	const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8')
	const { title, tagline } = readHero(readme)
	const intros = sectionIntros(readme)
	const sections = parseToc(readme)
		.map(({ text, anchor }) => {
			const intro = intros.get(anchor)
			return `- [${text}](${REPO}/blob/main/README.md#${anchor})${intro ? `: ${intro}` : ''}`
		})
		.join('\n')

	return `# ${title}

> ${tagline}

## Docs

${sections}

## Links

- [Full README](${REPO}/blob/main/README.md)
- [GitHub](${REPO})
- [npm](${NPM})
`
}

/**
 * Renders the whole page to static HTML at build time. Nothing here ships to
 * the browser — the client bundle only wires up the interactive bits.
 */
export async function renderPage(siteDir: string): Promise<RenderedPage> {
	const repoRoot = path.resolve(siteDir, '..')
	const readme = await readFile(path.join(repoRoot, 'README.md'), 'utf8')

	const highlighter = await createHighlighterCore({
		themes: [vitesseDark, vitesseLight],
		langs: [typescript, bash, json, sql],
		engine: createJavaScriptRegexEngine({ forgiving: true }),
	})
	const loadedLangs = new Set(highlighter.getLoadedLanguages())
	const headings: { id: string; text: string }[] = []

	const marked = new Marked({
		gfm: true,
		renderer: {
			code({ text, lang }) {
				const resolved = lang && loadedLangs.has(lang) ? lang : 'text'
				const pre = highlighter.codeToHtml(text, {
					lang: resolved,
					themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
					defaultColor: false,
				})
				// Window chrome: language tag on the left, copy on the right.
				return `<figure class="code-block">
					<figcaption class="code-bar">
						<span class="code-lang">${escapeHtml(resolved)}</span>
						<button class="code-copy" type="button">Copy</button>
					</figcaption>
					${pre}
				</figure>`
			},
			heading({ text, depth, tokens }) {
				const id = slugify(text)
				const inner = this.parser.parseInline(tokens)
				if (depth === 2 && id !== 'table-of-contents')
					headings.push({ id, text })
				return `<h${depth} id="${id}"><a class="anchor" href="#${id}" aria-label="Link to ${escapeHtml(text)}">#</a>${inner}</h${depth}>`
			},
		},
	})

	const { title, tagline, install } = readHero(readme)
	// Wide API tables scroll on their own instead of blowing out the page.
	const body = (marked.parse(prepareBody(readme)) as string)
		.replace(/<table>/g, '<div class="table-wrap"><table>')
		.replace(/<\/table>/g, '</table></div>')

	const rail = headings
		.map(
			({ id, text }) =>
				`<li><a href="#${id}" data-spy="${id}">${escapeHtml(text)}</a></li>`,
		)
		.join('')

	// Section grid: the README's own contents list, each entry carrying the
	// intro sentence from the section it points at.
	const intros = sectionIntros(readme)
	const sections = parseToc(readme)
		.map(({ text, anchor }) => {
			const intro = intros.get(anchor)
			return `<a class="section-card" href="#${escapeHtml(anchor)}">
				<span class="section-name">${escapeHtml(text)}</span>
				${intro ? `<span class="section-desc">${escapeHtml(intro)}</span>` : ''}
			</a>`
		})
		.join('')

	const html = `<a class="skip" href="#content">Skip to content</a>
	<header class="nav">
		<div class="nav-inner">
			<a class="brand" href="#top">
				<span class="brand-name">${escapeHtml(title)}</span>
			</a>
			<nav class="nav-links">
				<a href="#quick-start">Docs</a>
				<a href="${REPO}">GitHub</a>
				<a href="${NPM}">npm</a>
				<a href="/llms.txt">llms.txt</a>
			</nav>
			<button class="theme-toggle" type="button" aria-label="Toggle color theme">
				<span class="theme-icon" aria-hidden="true"></span>
			</button>
		</div>
	</header>

	<main id="top">
		<section class="hero">
			<div class="hero-rules" aria-hidden="true"></div>
			<div class="hero-glow" aria-hidden="true"></div>
			<div class="hero-inner">
				<div class="hero-copy">
					<p class="eyebrow">
						<span class="eyebrow-dot" aria-hidden="true"></span>
						PostgreSQL · append-only audit log
					</p>
					<h1 class="hero-title">${escapeHtml(title)}</h1>
					<p class="hero-tagline">${escapeHtml(tagline)}</p>
					<div class="hero-actions">
						<div class="install-group">
							<div class="pm-tabs" role="tablist" aria-label="Package manager">
								${(['bun', 'npm', 'pnpm'] as const)
									.map(
										(pm, i) =>
											`<button class="pm-tab${i === 0 ? ' is-active' : ''}" type="button" role="tab" aria-selected="${i === 0}" data-pm="${pm}">${pm}</button>`,
									)
									.join('')}
							</div>
							<button class="install" type="button" data-copy="${escapeHtml(install.bun)}" data-install-bun="${escapeHtml(install.bun)}" data-install-npm="${escapeHtml(install.npm)}" data-install-pnpm="${escapeHtml(install.pnpm)}">
								<span class="prompt" aria-hidden="true">$</span>
								<code>${escapeHtml(install.bun)}</code>
								<span class="copy-state">copy</span>
							</button>
						</div>
						<div class="hero-links">
							<a class="btn btn-primary" href="${REPO}">
								<svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
									<path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
								</svg>
								GitHub
							</a>
						</div>
					</div>
				</div>
				<div class="hero-visual" aria-hidden="true">
					<div class="ledger-card">
						<div class="ledger-bar">
							<span class="ledger-label">audit.orders</span>
							<span class="ledger-live"><span class="ledger-live-dot"></span>tailing</span>
						</div>
						<div class="ledger-rows">
							${[
								{ op: '+', kind: 'INSERT', table: 'orders', actor: 'api-worker-2', time: '09:40:55.771' },
								{ op: '-', kind: 'DELETE', table: 'sessions', actor: 'svc-auth', time: '09:40:59.220' },
								{ op: '~', kind: 'UPDATE', table: 'invoices', actor: 'admin@acme', time: '09:41:04.902' },
								{ op: '~', kind: 'UPDATE', table: 'orders', actor: 'svc-billing', time: '09:41:07.114' },
							]
								.map(
									(row, i) => `<div class="ledger-row" style="--i:${i}">
								<span class="ledger-op ledger-op--${row.op === '+' ? 'ins' : row.op === '-' ? 'del' : 'upd'}">${row.op}</span>
								<span class="ledger-kind">${row.kind}</span>
								<span class="ledger-table">${row.table}</span>
								<span class="ledger-actor">${row.actor}</span>
								<span class="ledger-time">${row.time}</span>
							</div>`,
								)
								.join('')}
							<div class="ledger-row ledger-row--pending" style="--i:4">
								<span class="ledger-caret" aria-hidden="true"></span>
							</div>
						</div>
					</div>
					<p class="ledger-note">Nothing is ever overwritten. Every row grows the log.</p>
				</div>
			</div>
		</section>

		<div class="layout">
			<article class="prose" id="content">
				<nav class="sections" aria-label="Sections">${sections}</nav>
				${body}
			</article>
			<aside class="rail" aria-label="On this page">
				<p class="rail-head">On this page</p>
				<ul>${rail}</ul>
			</aside>
		</div>
	</main>

	<footer class="footer">
		<div class="footer-inner">
			<nav class="footer-links">
				<a href="https://x.com/linesofcode">X</a>
				<a href="https://www.linkedin.com/in/tim-mikeladze">LinkedIn</a>
			</nav>
		</div>
	</footer>`

	return {
		html,
		title: `${title} — ${tagline.replace(/\.$/, '')}`,
		description: tagline,
	}
}
