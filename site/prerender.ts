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

/**
 * The dashboard screens shown in the hero. Each is a real screenshot captured
 * from the running dashboard (see site/shots/README.md), in both themes — the
 * page shows whichever matches the visitor's, so a light screenshot never
 * lands on a dark page.
 */
const SHOTS = [
	{
		label: 'Explore',
		alt: 'The pg-history dashboard exploring audit entries, with a query console showing which search engine and index a query will use.',
		light: '/shots/explore-light.png',
		dark: '/shots/explore-dark.png',
	},
	{
		label: 'Timeline',
		alt: 'One record’s change timeline, each entry colour-coded by operation with a before and after diff.',
		light: '/shots/timeline-light.png',
		dark: '/shots/timeline-dark.png',
	},
	{
		label: 'Tables',
		alt: 'Every audited table with its last change, the operation that made it and the actor responsible.',
		light: '/shots/tables-light.png',
		dark: '/shots/tables-dark.png',
	},
] as const

const REPO = 'https://github.com/TimMikeladze/pg-history'
const NPM = 'https://www.npmjs.com/package/pg-history'

/**
 * One-click deploy. The button clones `dashboard/` on its own — the UI plus
 * the REST API it is built on, with archival driven by Vercel Cron.
 *
 * Every listed variable is a required field in the clone form, so only the
 * ones with a sensible non-secret default are prefilled through `envDefaults`;
 * the connection string, the table list, the JWT secret and the dashboard
 * password are left to the user — a default for any of those would end up in
 * the clone URL, and from there in browser history. Keep this list in step
 * with the README's Deployment section.
 */
const DEPLOY_ENV_DEFAULTS = {
	PG_HISTORY_JWT_ALG: 'HS256',
	PG_HISTORY_POOL_MAX: '3',
	PG_HISTORY_STATEMENT_TIMEOUT_MS: '30000',
	PG_HISTORY_DASHBOARD_ACTOR: 'dashboard',
	PG_HISTORY_RETENTION_DAYS: '90',
	PG_HISTORY_GRACE_PERIOD_DAYS: '7',
	PG_HISTORY_BATCH_SIZE: '10000',
} as const

const VERCEL_DEPLOY = `https://vercel.com/new/clone?${new URLSearchParams({
	'repository-url': `${REPO}/tree/main/dashboard`,
	'project-name': 'pg-history-dashboard',
	'repository-name': 'pg-history-dashboard',
	env: [
		'PG_HISTORY_DATABASE_URL',
		'PG_HISTORY_TABLES',
		'PG_HISTORY_JWT_SECRET',
		// Without this the deployed dashboard refuses to serve any page in
		// production — reaching one grants full audit read plus revert, so the
		// gate fails closed. Omitting it here would ship a one-click deploy that
		// 503s on first visit.
		'PG_HISTORY_DASHBOARD_PASSWORD',
		...Object.keys(DEPLOY_ENV_DEFAULTS),
	].join(','),
	envDefaults: JSON.stringify(DEPLOY_ENV_DEFAULTS),
	envDescription:
		'Only the first four need a value: a Postgres connection string, the tables to audit, a JWT signing secret, and a password for the dashboard UI (it can read and revert every audited record). The rest arrive prefilled with the library defaults.',
	envLink: `${REPO}#environment-variables`,
}).toString()}`

const DEPLOY_TARGETS = [
	{
		href: VERCEL_DEPLOY,
		name: 'Vercel',
		blurb:
			'The dashboard and the REST API it runs on, as one project — archival on Vercel Cron, and seven of the eleven environment variables already filled in.',
		icon: '<path fill="currentColor" d="M8 1.5 15 14H1L8 1.5Z"/>',
	},
] as const

/**
 * The three claims that decide whether a visitor keeps reading, drawn from
 * "How It Works" — each is a property of the design, not a feature list entry.
 */
const PILLARS = [
	{
		title: 'Nothing runs in your app',
		body: 'Triggers live in PostgreSQL. Every write is audited regardless of what connects — your app, a migration, <code>psql</code>, another service.',
	},
	{
		title: 'Same transaction, or neither',
		body: 'The audit row is written inside your transaction. If the write rolls back so does the entry, and a failed audit rolls back the write.',
	},
	{
		title: 'Old rows leave for S3',
		body: 'The archiver moves aged entries to compressed Parquet on S3 and deletes them in stages. No row is dropped without a verified backup.',
	},
] as const

/** The setup snippet, verbatim from the README's Quick Start. */
const SETUP_SNIPPET = `const history = new PgHistory({ pool, tables: ['users'] })
await history.setup()

// Every INSERT/UPDATE/DELETE on 'users' is audited from here on,
// whatever connects — no application code changes.
await pool.query(\`UPDATE users SET name = 'Alice' WHERE id = 1\`)

// Read the trail back, then undo one entry.
const { data } = await history.getHistory('users', '1')
await history.revert('users', '1', data[1].id)`

/** Title + tagline for the hero, so the README stays the only source of truth. */
function readHero(md: string) {
	const title = /^#\s+(.+)$/m.exec(md)?.[1] ?? 'pg-history'
	const tagline = md
		.split(/\r?\n/)
		.slice(1)
		.find((l) => l.trim() && !l.startsWith('['))
	const pkg = /```bash\nbun add ([^\n]+)\n```/.exec(md)?.[1] ?? 'pg-history'
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
	// "vercel.json" survive intact.
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

	// The hero pitch continues below the fold: what the design guarantees, and
	// the smallest complete program that uses it. Highlighted with the same
	// themes as the docs so the two read as one page.
	const setupHtml = highlighter.codeToHtml(SETUP_SNIPPET, {
		lang: 'typescript',
		themes: { light: 'vitesse-light', dark: 'vitesse-dark' },
		defaultColor: false,
	})

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
				<!-- The dashboard's mark, verbatim: three bars of unequal length,
				     shortest first — three audit entries stacked in time. -->
				<svg class="brand-mark" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
					<path d="M3 4h6M3 8h10M3 12h7" />
				</svg>
				<span class="brand-name">${escapeHtml(title)}</span>
			</a>
			<nav class="nav-links">
				<a href="#quick-start">Docs</a>
				<a href="#deploy-head">Deploy</a>
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
							<a class="btn" href="#dashboard">Dashboard</a>
							<a class="btn btn-primary" href="${REPO}">
								<svg class="btn-icon" viewBox="0 0 16 16" aria-hidden="true">
									<path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z"/>
								</svg>
								GitHub
							</a>
						</div>
					</div>
				</div>
				<div class="hero-visual">
					<!--
					  Real screenshots of the dashboard, not a mock. Each shot exists in
					  both themes; CSS shows only the one matching the visitor's, so a
					  light screenshot never lands on the dark page or vice versa.

					  None of these may be loading="lazy". Inactive shots are display:none,
					  and a lazy image inside a hidden box is never fetched — so clicking a
					  tab swapped in a blank frame that only filled once the load started.
					  fetchpriority keeps the visible shot first in the queue instead.
					-->
					<figure class="shots">
						${SHOTS.map(
							(
								shot,
								i,
							) => `<div class="shot${i === 0 ? ' is-active' : ''}" data-shot="${i}">
							<img class="shot-img shot-img--light" src="${shot.light}" alt="${escapeHtml(shot.alt)}" width="1400" height="900" fetchpriority="${i === 0 ? 'high' : 'low'}" decoding="async" />
							<img class="shot-img shot-img--dark" src="${shot.dark}" alt="${escapeHtml(shot.alt)}" width="1400" height="900" fetchpriority="${i === 0 ? 'high' : 'low'}" decoding="async" />
						</div>`,
						).join('')}
						<figcaption class="shot-caption">
							<span class="shot-label">The dashboard ships in the repo — browse, search and revert.</span>
							<span class="shot-tabs" role="tablist" aria-label="Dashboard screens">
								${SHOTS.map(
									(shot, i) =>
										`<button class="shot-tab${i === 0 ? ' is-active' : ''}" type="button" role="tab" aria-selected="${i === 0}" data-shot-tab="${i}">${escapeHtml(shot.label)}</button>`,
								).join('')}
							</span>
						</figcaption>
					</figure>
				</div>
			</div>
		</section>

		<section class="pitch" aria-label="Why pg-history">
			<div class="pitch-inner">
				<div class="pillars">
					${PILLARS.map(
						(p, i) => `<div class="pillar">
						<span class="pillar-num" aria-hidden="true">${String(i + 1).padStart(2, '0')}</span>
						<h2 class="pillar-title">${escapeHtml(p.title)}</h2>
						<p class="pillar-body">${p.body}</p>
					</div>`,
					).join('')}
				</div>
				<figure class="setup">
					<figcaption class="setup-bar">
						<span class="code-lang">The whole integration</span>
						<a class="setup-more" href="#quick-start">Quick Start →</a>
					</figcaption>
					${setupHtml}
				</figure>
			</div>
		</section>

		<section class="deploy" aria-labelledby="deploy-head">
			<div class="deploy-inner">
				<div class="deploy-intro">
					<h2 class="deploy-head" id="deploy-head">Deploy it in one click</h2>
					<p class="deploy-sub">The dashboard is in the repo already. Point it at a Postgres URL and the audit trail is live, browsable and revertible.</p>
				</div>
				<div class="deploy-cards">
					${DEPLOY_TARGETS.map(
						(target) => `<a class="deploy-card" href="${target.href}">
						<span class="deploy-card-head">
							<svg class="deploy-icon" viewBox="0 0 16 16" aria-hidden="true">${target.icon}</svg>
							<span class="deploy-name">${escapeHtml(target.name)}</span>
						</span>
						<span class="deploy-blurb">${target.blurb}</span>
						<span class="deploy-cta">Deploy to ${escapeHtml(target.name)} <span aria-hidden="true">→</span></span>
					</a>`,
					).join('')}
				</div>
			</div>
		</section>

		<div class="layout">
			<article class="prose" id="content">
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
