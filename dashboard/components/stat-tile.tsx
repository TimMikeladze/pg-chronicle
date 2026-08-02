import type * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Standalone figures use the font's proportional numerals — `tabular-nums`
 * gives every digit the width of a zero, which reads loose at display sizes.
 * Columns of numbers get `.tabular` instead.
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
		<div
			className={cn(
				'bg-card flex flex-col gap-1 rounded-xl border p-4',
				className,
			)}
		>
			<span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
				{label}
			</span>
			<span className="text-ink text-2xl leading-none font-semibold">
				{value}
			</span>
			{hint ? (
				<span className="text-muted-foreground text-xs">{hint}</span>
			) : null}
		</div>
	)
}

/**
 * The one number the view leads with. Exactly one per screen, in the same sans
 * as the rest of the UI — a display face here reads as decoration.
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
		<div className="bg-card flex flex-wrap items-end justify-between gap-4 rounded-xl border p-6">
			<div className="flex flex-col gap-2">
				<span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
					{label}
				</span>
				<span className="text-ink text-5xl leading-none font-semibold">
					{value}
				</span>
				{hint ? (
					<span className="text-muted-foreground text-sm">{hint}</span>
				) : null}
			</div>
			{action}
		</div>
	)
}
