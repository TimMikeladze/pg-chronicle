import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * A metric cell. Flat by default — these sit inside one shared bordered strip
 * and are separated by hairlines rather than each carrying its own box, so a
 * row of them reads as one instrument panel instead of competing cards.
 *
 * Figures are set in mono: these numbers sit directly above tables of the same
 * counts per table, and the two only line up if they share a face.
 */
export function StatTile({
	label,
	value,
	hint,
	className,
}: {
	label: string
	value: React.ReactNode
	hint?: React.ReactNode
	className?: string
}) {
	return (
		<div className={cn('flex flex-col gap-1.5 px-5 py-4', className)}>
			<span className="eyebrow">{label}</span>
			<span className="text-ink font-mono text-2xl leading-none font-medium tracking-tight">
				{value}
			</span>
			{hint ? (
				<span className="text-muted-foreground text-xs leading-relaxed">
					{hint}
				</span>
			) : null}
		</div>
	)
}

/**
 * Row of metric cells sharing one border, divided by hairlines. Collapses to a
 * single column on narrow screens, where vertical rules would otherwise cut a
 * wrapped value in half.
 */
export function StatRow({
	children,
	className,
	columns = 3,
}: {
	children: React.ReactNode
	className?: string
	columns?: 2 | 3 | 4
}) {
	return (
		<div
			className={cn(
				'bg-card grid grid-cols-1 divide-y rounded-lg border sm:divide-y-0',
				'sm:[&>*:not(:first-child)]:border-l',
				columns === 2 && 'sm:grid-cols-2',
				columns === 3 && 'sm:grid-cols-3',
				columns === 4 && 'sm:grid-cols-2 lg:grid-cols-4',
				// At the 2×2 breakpoint the third cell starts a new row and needs its
				// own top rule, which the lg 1×4 layout must then drop again.
				columns === 4 &&
					'sm:[&>*:nth-child(n+3)]:border-t lg:[&>*:nth-child(n+3)]:border-t-0',
				columns === 4 &&
					'sm:[&>*:nth-child(3)]:border-l-0 lg:[&>*:nth-child(3)]:border-l',
				className,
			)}
		>
			{children}
		</div>
	)
}

/**
 * The one number a view leads with. Paired with the control that changes it —
 * a backlog figure is only actionable next to the button that drains it.
 */
export function HeroFigure({
	label,
	value,
	hint,
	action,
}: {
	label: string
	value: React.ReactNode
	hint?: React.ReactNode
	action?: React.ReactNode
}) {
	return (
		<div className="bg-card relative overflow-hidden rounded-lg border">
			<div aria-hidden className="grid-field absolute inset-0 opacity-[0.35]" />
			<div className="relative flex flex-wrap items-end justify-between gap-6 p-6">
				<div className="flex flex-col gap-2">
					<span className="eyebrow">{label}</span>
					<span className="text-ink font-mono text-5xl leading-none font-medium tracking-tighter">
						{value}
					</span>
					{hint ? (
						<span className="text-muted-foreground text-[13px]">{hint}</span>
					) : null}
				</div>
				{action ? <div className="shrink-0">{action}</div> : null}
			</div>
		</div>
	)
}
