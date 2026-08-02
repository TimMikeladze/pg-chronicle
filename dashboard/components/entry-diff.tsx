'use client'

import type { LucideIcon } from 'lucide-react'
import {
	ArrowRightIcon,
	MinusIcon,
	PencilLineIcon,
	PlusIcon,
} from 'lucide-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import type { FieldChange, FieldChangeKind } from '@/lib/diff'
import { changedFields, diffEntry, renderValue } from '@/lib/diff'
import type { AuditEntryWire } from '@/lib/types'
import { cn } from '@/lib/utils'

const KIND_STYLE: Record<
	Exclude<FieldChangeKind, 'unchanged'>,
	{ icon: LucideIcon; color: string; srLabel: string }
> = {
	added: { icon: PlusIcon, color: 'var(--status-good)', srLabel: 'Added' },
	removed: {
		icon: MinusIcon,
		color: 'var(--status-critical)',
		srLabel: 'Removed',
	},
	changed: {
		icon: PencilLineIcon,
		color: 'var(--status-warning)',
		srLabel: 'Changed',
	},
}

function ValueCell({ value, muted }: { value: unknown; muted?: boolean }) {
	const text = renderValue(value)
	return (
		<pre
			className={cn(
				'font-mono text-xs leading-relaxed break-words whitespace-pre-wrap',
				muted ? 'text-muted-foreground' : 'text-foreground',
				value === undefined && 'text-muted-foreground italic',
			)}
		>
			{text}
		</pre>
	)
}

function ChangeRow({ change }: { change: FieldChange }) {
	if (change.kind === 'unchanged') {
		return (
			<div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-3 px-3 py-2">
				<ValueCell value={change.before} muted />
				<span className="text-muted-foreground/50 pt-0.5 text-xs">=</span>
				<ValueCell value={change.after} muted />
			</div>
		)
	}

	const style = KIND_STYLE[change.kind]
	const Icon = style.icon

	return (
		<div
			className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-start gap-3 px-3 py-2"
			style={{
				backgroundColor: `color-mix(in srgb, ${style.color} 7%, transparent)`,
			}}
		>
			<ValueCell value={change.before} muted={change.kind === 'added'} />
			<span className="flex items-center gap-1 pt-0.5">
				<Icon aria-hidden className="size-3" style={{ color: style.color }} />
				<span className="sr-only">{style.srLabel}</span>
				<ArrowRightIcon
					aria-hidden
					className="text-muted-foreground/60 size-3"
				/>
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
			<p className="text-muted-foreground rounded-lg border border-dashed p-4 text-sm">
				{entry.operation === 'TRUNCATE'
					? 'TRUNCATE is recorded as a table-level marker — there is no row payload to compare.'
					: 'This entry carries no column data. Every audited column may be listed in excludeColumns.'}
			</p>
		)
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="overflow-hidden rounded-lg border">
				<div className="bg-inset text-muted-foreground grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] gap-3 border-b px-3 py-1.5 text-xs font-medium tracking-wide uppercase">
					<span>Before</span>
					<span className="w-8" />
					<span>After</span>
				</div>
				{rows.map((change) => (
					<div key={change.key} className="border-b last:border-b-0">
						<div className="text-muted-foreground bg-background/60 px-3 pt-2 font-mono text-[11px]">
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

/** One-line summary of what moved, for dense table rows. */
export function ChangeSummary({ entry }: { entry: AuditEntryWire }) {
	const changed = changedFields(diffEntry(entry))
	if (changed.length === 0) {
		return <span className="text-muted-foreground text-xs">no columns</span>
	}
	const shown = changed.slice(0, 3).map((c) => c.key)
	const rest = changed.length - shown.length
	return (
		<span className="text-muted-foreground font-mono text-xs">
			{shown.join(', ')}
			{rest > 0 ? ` +${rest}` : ''}
		</span>
	)
}
