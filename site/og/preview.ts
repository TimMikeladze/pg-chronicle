/**
 * Writes the social card to site/og-preview.png so it can be looked at without
 * running a build. Gitignored — the card that ships is the one vite emits.
 */
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { renderCard } from './card.ts'

const siteDir = path.resolve(import.meta.dirname, '..')
const out = path.join(siteDir, 'og-preview.png')
await writeFile(out, await renderCard(siteDir))
console.log(out)
