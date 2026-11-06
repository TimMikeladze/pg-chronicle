import { readFile, writeFile } from 'node:fs/promises'
import type { BunupPlugin } from 'bunup'

/**
 * Restores `.name` on exports that Bun's splitter renamed.
 *
 * Bun 1.4 (up to at least 1.4.4) numbers a binding in a shared chunk whenever
 * an entry point exports the same name, so `export { PgChronicle }` in
 * src/index.ts turns the class in the chunk into `PgChronicle2` and the entry
 * re-exports it as `PgChronicle2 as PgChronicle`. Imports still work, but
 * `PgChronicle.name`, `util.inspect` output and stack frames all say
 * `PgChronicle2`, and the ESM build disagrees with the CJS build (which is not
 * split). Upstream fix: https://github.com/oven-sh/bun/pull/42552. Delete this
 * plugin once a Bun release ships it.
 *
 * It only appends `Object.defineProperty(X2, "name", { value: "X" })` after
 * the declaration's chunk is written. No identifiers are rewritten, so it
 * cannot change what any binding refers to.
 */
export function keepExportNames(): BunupPlugin {
	return {
		name: 'keep-export-names',
		hooks: {
			onBuildDone: async ({ files }) => {
				const js = files.filter(
					(f) =>
						f.format === 'esm' &&
						!f.dts &&
						(f.kind === 'entry-point' || f.kind === 'chunk') &&
						f.fullPath.endsWith('.js'),
				)
				const sources = new Map<string, string>()
				for (const f of js)
					sources.set(f.fullPath, await readFile(f.fullPath, 'utf8'))

				// `Foo2 as Foo` in any export clause: the renamed binding and the name
				// it was meant to have.
				const renamed = new Map<string, string>()
				for (const source of sources.values()) {
					for (const clause of source.matchAll(/export\s*\{([^}]*)\}/g)) {
						for (const m of (clause[1] ?? '').matchAll(
							/([A-Za-z_$][\w$]*?)(\d+) as ([A-Za-z_$][\w$]*)/g,
						)) {
							const [, base, suffix, alias] = m
							if (alias && base === alias)
								renamed.set(`${base}${suffix}`, alias)
						}
					}
				}
				if (renamed.size === 0) return

				for (const [path, source] of sources) {
					const fixes: string[] = []
					for (const [binding, name] of renamed) {
						const declared = new RegExp(
							`^(?:async\\s+)?(?:class|function\\*?|const|let|var)\\s+${binding.replace(/\$/g, '\\$')}\\b`,
							'm',
						)
						if (!declared.test(source)) continue
						fixes.push(
							`if (typeof ${binding} === "function") Object.defineProperty(${binding}, "name", { value: ${JSON.stringify(name)} });`,
						)
					}
					if (fixes.length > 0) {
						await writeFile(
							path,
							`${source.trimEnd()}\n\n// keep-export-names (oven-sh/bun#42552)\n${fixes.join('\n')}\n`,
						)
					}
				}
			},
		},
	}
}
