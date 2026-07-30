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
	const install =
		/```bash\n(bun add [^\n]+)\n```/.exec(md)?.[1] ?? 'bun add pg-history'
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
 * Renders the whole page to static HTML at build time. Nothing here ships to
 * the browser — the client bundle only wires up the interactive bits.
 */
export async function renderPage(siteDir: string): Promise<RenderedPage> {
	const repoRoot = path.resolve(siteDir, '..')
	const [readme, pkgRaw] = await Promise.all([
		readFile(path.join(repoRoot, 'README.md'), 'utf8'),
		readFile(path.join(repoRoot, 'package.json'), 'utf8'),
	])
	const version = (JSON.parse(pkgRaw) as { version: string }).version

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
				<svg class="brand-mark" viewBox="0 0 32 32" fill="currentColor" aria-hidden="true">
					<ellipse cx="19" cy="10.5" rx="3.4" ry="4" />
					<ellipse cx="13" cy="17.5" rx="7.5" ry="6.3" />
					<circle cx="21.5" cy="14" r="5.3" />
					<path d="M25.6 15.5c1.6 2.7 1.1 6.1-1.6 7.6 1.7-2.8 1.2-5.3.2-7.1z" />
					<rect x="8" y="22.3" width="2.2" height="5" rx="1.1" />
					<rect x="11.4" y="23" width="2.2" height="5" rx="1.1" />
					<rect x="16.4" y="23" width="2.2" height="5" rx="1.1" />
					<rect x="19.8" y="22.3" width="2.2" height="5" rx="1.1" />
					<path d="M6.3 15.2c-1.6 1-1.7 3.5-.2 4.9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
				</svg>
				<span class="brand-name">${escapeHtml(title)}</span>
			</a>
			<span class="version">v${escapeHtml(version)}</span>
			<nav class="nav-links">
				<a href="#quick-start">Docs</a>
				<a href="${REPO}">GitHub</a>
				<a href="${NPM}">npm</a>
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
				<p class="eyebrow">
					<span class="eyebrow-dot" aria-hidden="true"></span>
					PostgreSQL · append-only audit log
				</p>
				<h1 class="hero-title">${escapeHtml(title)}</h1>
				<p class="hero-tagline">${escapeHtml(tagline)}</p>
				<div class="hero-actions">
					<button class="install" type="button" data-copy="${escapeHtml(install)}">
						<span class="prompt" aria-hidden="true">$</span>
						<code>${escapeHtml(install)}</code>
						<span class="copy-state">copy</span>
					</button>
					<div class="hero-links">
						<a class="btn btn-primary" href="${REPO}">GitHub</a>
						<a class="btn" href="${NPM}">npm</a>
					</div>
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
			<span class="footer-mark">${escapeHtml(title)}</span>
			<span class="footer-meta">MIT · © Tim Mikeladze</span>
			<nav class="footer-links">
				<a href="${REPO}">GitHub</a>
				<a href="${NPM}">npm</a>
				<a href="${REPO}/issues">Issues</a>
			</nav>
		</div>
	</footer>`

	return {
		html,
		title: `${title} — ${tagline.replace(/\.$/, '')}`,
		description: tagline,
	}
}
