import type { LucideIcon } from 'lucide-react'
import {
	AlertTriangleIcon,
	CheckCircle2Icon,
	CircleDashedIcon,
	EraserIcon,
	LoaderIcon,
	MinusIcon,
	PencilLineIcon,
	PlusIcon,
	XCircleIcon,
} from 'lucide-react'
import { OPERATION_META, tintStyle } from '@/lib/operations'
import type { ArchivalStatus, Operation } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Status hue is carried by the icon and a tint, never by the label text — the
 * label keeps full foreground contrast, and the icon plus the word itself mean
 * the chip is still readable with no color perception at all.
 */
function StatusChip({
	icon: Icon,
	label,
	color,
	className,
	title,
}: {
	icon: LucideIcon
	label: string
	/** A `--status-*` / `--op-*` custom property, or `null` for the neutral case. */
	color: string | null
	className?: string
	title?: string
}) {
	return (
		<span
			title={title}
			className={cn(
				'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium tracking-tight whitespace-nowrap',
				color === null && 'border-border bg-inset text-foreground',
				className,
			)}
			style={color === null ? undefined : tintStyle(color)}
		>
			<Icon
				aria-hidden
				className="size-3 shrink-0"
				style={color === null ? undefined : { color }}
			/>
			{label}
		</span>
	)
}

const OPERATION_ICON: Record<Operation, LucideIcon> = {
	INSERT: PlusIcon,
	UPDATE: PencilLineIcon,
	DELETE: MinusIcon,
	TRUNCATE: EraserIcon,
}

export function OperationBadge({
	operation,
	className,
}: {
	operation: Operation
	className?: string
}) {
	const meta = OPERATION_META[operation]
	return (
		<StatusChip
			icon={OPERATION_ICON[operation]}
			label={operation}
			color={meta.color}
			title={`${meta.verb} — ${meta.captured}`}
			className={className}
		/>
	)
}

export function HealthBadge({ status }: { status: string }) {
	if (status === 'ok') {
		return (
			<StatusChip
				icon={CheckCircle2Icon}
				label="Healthy"
				color="var(--status-good)"
				title="The API answered and its database probe succeeded"
			/>
		)
	}
	if (status === 'degraded') {
		return (
			<StatusChip
				icon={AlertTriangleIcon}
				label="Degraded"
				color="var(--status-warning)"
				title="The API is up but the last archival run failed"
			/>
		)
	}
	return (
		<StatusChip
			icon={XCircleIcon}
			label="Unreachable"
			color="var(--status-critical)"
			title="The database probe failed — the API is returning 503"
		/>
	)
}

const ARCHIVAL_STYLE: Record<
	ArchivalStatus,
	{ icon: LucideIcon; color: string | null; label: string }
> = {
	idle: { icon: CircleDashedIcon, color: null, label: 'Idle' },
	running: {
		icon: LoaderIcon,
		color: 'var(--status-warning)',
		label: 'Running',
	},
	completed: {
		icon: CheckCircle2Icon,
		color: 'var(--status-good)',
		label: 'Completed',
	},
	failed: {
		icon: XCircleIcon,
		color: 'var(--status-critical)',
		label: 'Failed',
	},
}

export function ArchivalStatusBadge({ status }: { status: ArchivalStatus }) {
	const style = ARCHIVAL_STYLE[status] ?? ARCHIVAL_STYLE.idle
	return (
		<StatusChip icon={style.icon} label={style.label} color={style.color} />
	)
}

/**
 * Bordered callout for a failure the operator has to read in full — an archival
 * error, a rate-limit rejection, a failed revert. Distinct from a toast because
 * these persist and often carry a message worth copying.
 */
export function Callout({
	tone = 'critical',
	title,
	children,
}: {
	tone?: 'critical' | 'warning' | 'neutral'
	title?: string
	children: React.ReactNode
}) {
	const color =
		tone === 'critical'
			? 'var(--status-critical)'
			: tone === 'warning'
				? 'var(--status-warning)'
				: null

	return (
		<div
			className={cn(
				'rounded-lg border p-3 text-sm',
				color === null && 'bg-inset',
			)}
			style={
				color === null ? undefined : tintStyle(color, { border: 35, fill: 7 })
			}
		>
			{title ? (
				<p className="text-ink mb-1 text-[13px] font-medium">{title}</p>
			) : null}
			<div className="text-muted-foreground text-[13px] leading-relaxed break-words">
				{children}
			</div>
		</div>
	)
}
