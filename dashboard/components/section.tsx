import { cn } from '@/lib/utils'

/**
 * The layout is a stack of sections separated by hairlines, not a grid of
 * cards. Nesting a card inside a card was the old structure's main failure: an
 * archival table inside a bordered panel inside a page gutter produced three
 * concentric rounded rectangles and no hierarchy at all.
 *
 * A Section owns its own heading and rule. Content sits directly on the page
 * background unless it is genuinely a discrete object (a result row, a diff).
 */
export function Section({
	title,
	description,
	action,
	className,
	children,
}: {
	title: string
	description?: React.ReactNode
	action?: React.ReactNode
	className?: string
	children: React.ReactNode
}) {
	return (
		<section className={cn('flex flex-col gap-4', className)}>
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div className="flex flex-col gap-1">
					<h2 className="eyebrow">{title}</h2>
					{description ? (
						<p className="text-muted-foreground max-w-2xl text-[13px] leading-relaxed">
							{description}
						</p>
					) : null}
				</div>
				{action ? <div className="shrink-0">{action}</div> : null}
			</div>
			{children}
		</section>
	)
}

/**
 * A bordered container for tabular content. Kept separate from Section so a
 * section can hold either a framed table or bare content, without the frame
 * being implied by the heading.
 */
export function Panel({
	className,
	children,
}: {
	className?: string
	children: React.ReactNode
}) {
	return (
		<div className={cn('bg-card overflow-hidden rounded-lg border', className)}>
			{children}
		</div>
	)
}

/**
 * The footer strip on a Panel — result counts on the left, pagination on the
 * right. Consistent placement matters more than the styling here: it is the one
 * control that appears on every list in the product.
 */
export function PanelFooter({
	children,
	className,
}: {
	children: React.ReactNode
	className?: string
}) {
	return (
		<div
			className={cn(
				'bg-inset/60 flex items-center justify-between gap-3 border-t px-4 py-2.5',
				className,
			)}
		>
			{children}
		</div>
	)
}

/**
 * Empty state. Always states the cause and the next action — an audit trail
 * with no visible rows is ambiguous by nature (never written? wrong id?
 * archived?), and an unexplained blank panel makes the operator guess.
 */
export function EmptyState({
	title,
	children,
	action,
}: {
	title: string
	children?: React.ReactNode
	action?: React.ReactNode
}) {
	return (
		<div className="relative overflow-hidden rounded-lg border border-dashed">
			<div aria-hidden className="grid-field absolute inset-0 opacity-40" />
			<div className="relative flex flex-col items-center gap-2 px-6 py-14 text-center">
				<p className="text-ink text-sm font-medium">{title}</p>
				{children ? (
					<div className="text-muted-foreground max-w-md text-[13px] leading-relaxed">
						{children}
					</div>
				) : null}
				{action ? <div className="mt-2">{action}</div> : null}
			</div>
		</div>
	)
}
