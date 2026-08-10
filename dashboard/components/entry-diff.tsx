'use client'

import type { LucideIcon } from 'lucide-react'
import { MinusIcon, PencilLineIcon, PlusIcon } from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import type { FieldChange, FieldChangeKind } from '@/lib/diff'
import {
	changedFields,
	diffEntry,
	onlyExcludedColumnsChanged,
	renderValue,
} from '@/lib/diff'
import { OPERATION_META } from '@/lib/operations'
import type { AuditEntryWire } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Diff kinds borrow the operation palette: a field appearing is the same green
 * as an INSERT, a field vanishing the same red as a DELETE. One vocabulary for
 * "something came into existence" across both scales.
 */
const KIND_STYLE: Record<
	Exclude<FieldChangeKind, 'unchanged'>,
	{ icon: LucideIcon; color: string; srLabel: string }
> = {
	added: { icon: PlusIcon, color: 'var(--op-insert)', srLabel: 'Added' },
	removed: { icon: MinusIcon, color: 'var(--op-delete)', srLabel: 'Removed' },
	changed: {
		icon: PencilLineIcon,
		color: 'var(--op-update)',
		srLabel: 'Changed',
	},
}

function ValueCell({ value, muted }: { value: unknown; muted?: boolean }) {
	const text = renderValue(value)
	// `undefined` renders as an em dash meaning "no such key on this side" — it
	// must not look like the string "null", which is a value the row actually
	// holds. The italic treatment marks absence, not content.
	const absent = value === undefined
	return (
		<pre
			className={cn(
				'font-mono text-xs leading-relaxed break-words whitespace-pre-wrap',
				muted ? 'text-muted-foreground' : 'text-foreground',
				absent && 'text-muted-foreground/60 italic',
				value === null && 'text-muted-foreground italic',
			)}
		>
			{text}
		</pre>
	)
}

function ChangeRow({ change }: { change: FieldChange }) {
	// Narrow before indexing: KIND_STYLE has no 'unchanged' key, and reading it
	// through the union type would resolve to undefined at runtime.
	const style = change.kind === 'unchanged' ? null : KIND_STYLE[change.kind]
	const Icon = style?.icon

	return (
		<div
			className={cn(
				'grid grid-cols-[minmax(0,1fr)_1.5rem_minmax(0,1fr)] items-start gap-4 px-4 py-2.5',
				// The rail restates the change kind at the row's leading edge, so a
				// long diff can be scanned down the gutter without reading values.
				style && 'op-rail',
			)}
			style={
				style
					? ({
							'--rail-color': style.color,
							backgroundColor: `color-mix(in srgb, ${style.color} 5%, transparent)`,
						} as React.CSSProperties)
					: undefined
			}
		>
			<ValueCell value={change.before} muted={change.kind === 'added'} />
			{/* The marker sits in a fixed-width gutter centred between the two
			    values, so the eye has a consistent hinge to read across even when
			    one side is a single word and the other a JSON blob. */}
			<span className="flex items-start justify-center pt-0.5">
				{Icon && style ? (
					<>
						<Icon
							aria-hidden
							className="size-3"
							style={{ color: style.color }}
						/>
						<span className="sr-only">{style.srLabel}</span>
					</>
				) : (
					<span className="text-muted-foreground/40 text-xs">=</span>
				)}
			</span>
			<ValueCell value={change.after} muted={change.kind === 'removed'} />
		</div>
	)
}

/**
 * Field-level view of one audit entry. Unchanged columns are collapsed by
 * default — on a wide table they drown the two columns that actually moved —
 * but the count is always stated so nothing looks hidden.
 */
export function EntryDiff({ entry }: { entry: AuditEntryWire }) {
	const [showUnchanged, setShowUnchanged] = useState(false)
	const all = diffEntry(entry)
	const changed = changedFields(all)
	const unchangedCount = all.length - changed.length
	const rows = showUnchanged ? all : changed

	if (all.length === 0) {
		return (
			<p className="text-muted-foreground rounded-lg border border-dashed p-4 text-[13px] leading-relaxed">
				{entry.operation === 'TRUNCATE'
					? OPERATION_META.TRUNCATE.captured
					: 'This entry carries no column data. Every audited column may be listed in excludeColumns.'}
			</p>
		)
	}

	// A real change the diff cannot show. Falling through would render a header
	// with no rows, which reads as a broken entry rather than a redacted one.
	if (onlyExcludedColumnsChanged(entry, all)) {
		return (
			<p className="text-muted-foreground rounded-lg border border-dashed p-4 text-[13px] leading-relaxed">
				A redacted column changed. Every audited column is identical here, and
				the trigger only records an UPDATE when the row actually changed — so
				what moved is listed in{' '}
				<code className="text-foreground font-mono text-xs">
					excludeColumns
				</code>{' '}
				and is deliberately not captured. The trail keeps the fact and the
				timing, never the value.
			</p>
		)
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="overflow-hidden rounded-lg border">
				<div className="bg-inset text-muted-foreground grid grid-cols-[minmax(0,1fr)_1.5rem_minmax(0,1fr)] gap-4 border-b px-4 py-2 font-mono text-[11px] font-medium tracking-[0.08em] uppercase">
					<span>Before</span>
					<span />
					<span>After</span>
				</div>
				{rows.map((change) => (
					<div key={change.key} className="border-b last:border-b-0">
						<div className="text-muted-foreground bg-background/40 px-4 pt-2 font-mono text-[11px]">
							{change.key}
						</div>
						<ChangeRow change={change} />
					</div>
				))}
			</div>

			{unchangedCount > 0 ? (
				<Button
					variant="ghost"
					size="sm"
					className="self-start"
					onClick={() => setShowUnchanged((v) => !v)}
				>
					{showUnchanged
						? `Hide ${unchangedCount} unchanged column${unchangedCount === 1 ? '' : 's'}`
						: `Show ${unchangedCount} unchanged column${unchangedCount === 1 ? '' : 's'}`}
				</Button>
			) : null}
		</div>
	)
}

/**
 * One-line summary of what moved, for dense table rows. Column names are the
 * scanning target, so they stay in mono at full contrast while the overflow
 * count recedes.
 */
export function ChangeSummary({ entry }: { entry: AuditEntryWire }) {
	const all = diffEntry(entry)
	const changed = changedFields(all)
	if (changed.length === 0) {
		// "no columns" would be wrong for a redacted update: something changed,
		// it is just not something this trail is allowed to show.
		const label = onlyExcludedColumnsChanged(entry, all)
			? 'redacted column'
			: entry.operation === 'TRUNCATE'
				? 'table-level'
				: 'no columns'
		return (
			<span className="text-muted-foreground/60 text-xs italic">{label}</span>
		)
	}
	const shown = changed.slice(0, 3)
	const rest = changed.length - shown.length
	return (
		<span className="flex flex-wrap items-center gap-1">
			{shown.map((c) => {
				// changedFields() has already dropped 'unchanged', but the type does
				// not carry that — narrow rather than assert so a future change to
				// the filter cannot silently index a missing key.
				const color =
					c.kind === 'unchanged' ? 'var(--border)' : KIND_STYLE[c.kind].color
				return (
					<span
						key={c.key}
						className="bg-inset text-foreground rounded border px-1.5 py-0.5 font-mono text-[11px]"
						style={{
							borderColor: `color-mix(in srgb, ${color} 30%, transparent)`,
						}}
					>
						{c.key}
					</span>
				)
			})}
			{rest > 0 ? (
				<span className="text-muted-foreground font-mono text-[11px]">
					+{rest}
				</span>
			) : null}
		</span>
	)
}
