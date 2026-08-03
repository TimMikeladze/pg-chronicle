import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import '@fontsource/geist-sans/400.css'
import '@fontsource/geist-sans/500.css'
import '@fontsource/geist-sans/600.css'
import './style.css'

/*
 * The page itself is prerendered at build time (see build/render.ts). All this
 * does is wire up the parts that need a browser.
 */

/** Every selector below targets prerendered markup — miss loudly. */
function must<T extends Element>(
	selector: string,
	scope: ParentNode = document,
) {
	const el = scope.querySelector<T>(selector)
	if (!el) throw new Error(`pghistory site: missing element ${selector}`)
	return el
}

/* ---------- theme (the stored value is applied inline in <head>) ---------- */

const root = document.documentElement

must('.theme-toggle').addEventListener('click', () => {
	const current =
		root.dataset.theme ??
		(matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
	const next = current === 'dark' ? 'light' : 'dark'
	root.dataset.theme = next
	localStorage.setItem('theme', next)
})

/* ---------- copy buttons ---------- */

function wireCopy(
	button: HTMLElement,
	getText: () => string,
	label: HTMLElement,
) {
	button.addEventListener('click', async () => {
		await navigator.clipboard.writeText(getText())
		const previous = label.textContent
		label.textContent = 'copied'
		button.classList.add('is-copied')
		setTimeout(() => {
			label.textContent = previous
			button.classList.remove('is-copied')
		}, 1500)
	})
}

const installButton = must<HTMLButtonElement>('.install')
wireCopy(
	installButton,
	() => installButton.dataset.copy ?? '',
	must<HTMLElement>('.copy-state', installButton),
)

const installCode = must<HTMLElement>('code', installButton)
for (const tab of document.querySelectorAll<HTMLButtonElement>('.pm-tab')) {
	tab.addEventListener('click', () => {
		const pm = tab.dataset.pm ?? 'bun'
		const command =
			installButton.dataset[`install${pm[0]?.toUpperCase()}${pm.slice(1)}`]
		if (!command) return
		installButton.dataset.copy = command
		installCode.textContent = command
		for (const other of document.querySelectorAll<HTMLButtonElement>(
			'.pm-tab',
		)) {
			other.classList.toggle('is-active', other === tab)
			other.setAttribute('aria-selected', String(other === tab))
		}
	})
}

for (const block of document.querySelectorAll<HTMLElement>('.code-block')) {
	const button = must<HTMLButtonElement>('.code-copy', block)
	wireCopy(button, () => block.querySelector('pre')?.textContent ?? '', button)
}

/* ---------- hero screenshot tabs ---------- */

/*
 * Both theme variants of every shot are already in the DOM; this only switches
 * which screen is shown. The light/dark pairing is pure CSS, so the tabs never
 * have to know what theme is active.
 */
const shots = [...document.querySelectorAll<HTMLElement>('[data-shot]')]
const shotTabs = [
	...document.querySelectorAll<HTMLButtonElement>('[data-shot-tab]'),
]

for (const tab of shotTabs) {
	tab.addEventListener('click', () => {
		const index = tab.dataset.shotTab
		for (const shot of shots) {
			shot.classList.toggle('is-active', shot.dataset.shot === index)
		}
		for (const other of shotTabs) {
			const active = other === tab
			other.classList.toggle('is-active', active)
			other.setAttribute('aria-selected', String(active))
		}
	})
}

/* ---------- scroll spy for the rail ---------- */

const spyLinks = new Map<string, HTMLAnchorElement>()
for (const link of document.querySelectorAll<HTMLAnchorElement>('[data-spy]')) {
	if (link.dataset.spy) spyLinks.set(link.dataset.spy, link)
}

const order = [...spyLinks.keys()]
const visible = new Set<string>()

const observer = new IntersectionObserver(
	(entries) => {
		for (const entry of entries) {
			if (entry.isIntersecting) visible.add(entry.target.id)
			else visible.delete(entry.target.id)
		}
		// Headings report in document order, so the first visible one wins.
		const active = order.find((id) => visible.has(id))
		for (const [id, link] of spyLinks) {
			link.classList.toggle('is-active', id === active)
		}
	},
	{ rootMargin: '-72px 0px -70% 0px' },
)

for (const id of order) {
	const el = document.getElementById(id)
	if (el) observer.observe(el)
}

/* ---------- nav shadow once scrolled off the hero ---------- */

const navEl = must('.nav')
new IntersectionObserver(
	(entries) => {
		const entry = entries[0]
		if (entry) navEl.classList.toggle('is-stuck', !entry.isIntersecting)
	},
	{ threshold: 0 },
).observe(must('.hero-inner'))
