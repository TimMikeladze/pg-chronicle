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
 * Drop the leading title/tagline/badges — the hero renders those — and point
 * repo-relative links at GitHub so they resolve off-repo.
 */
function prepareBody(md: string) {
	const tocIndex = md.indexOf('## Table of Contents')
	const body = tocIndex === -1 ? md : md.slice(tocIndex)
	return body.replace(/\]\(\.\/([^)]+)\)/g, `](${REPO}/blob/main/$1)`)
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

	const html = `<a class="skip" href="#content">Skip to content</a>
	<header class="nav">
		<div class="nav-inner">
			<a class="brand" href="#top">
				<span class="brand-mark" aria-hidden="true"></span>
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
			<article class="prose" id="content">${body}</article>
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
