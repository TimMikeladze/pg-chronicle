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
import type { ArchivalStatus, Operation } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * Status hue is carried by the icon and a tint, never by the label text — the
 * label keeps full foreground contrast, and the icon plus the word itself mean
 * the badge is still readable with no color perception at all.
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
	/** A `--status-*` custom property, or `null` for the neutral/monochrome case. */
	color: string | null
	className?: string
	title?: string
}) {
	return (
		<span
			title={title}
			className={cn(
				'inline-flex w-fit shrink-0 items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium whitespace-nowrap',
				color === null && 'border-border bg-inset text-foreground',
				className,
			)}
			style={
				color === null
					? undefined
					: {
							borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
							backgroundColor: `color-mix(in srgb, ${color} 12%, transparent)`,
						}
			}
		>
			<Icon
				aria-hidden
				className="size-3"
				style={color === null ? undefined : { color }}
			/>
			{label}
		</span>
	)
}

const OPERATION_STYLE: Record<
	Operation,
	{ icon: LucideIcon; color: string; hint: string }
> = {
	INSERT: {
		icon: PlusIcon,
		color: 'var(--status-good)',
		hint: 'Row created — only new values were captured',
	},
	UPDATE: {
		icon: PencilLineIcon,
		color: 'var(--status-warning)',
		hint: 'Row modified — both before and after values were captured',
	},
	DELETE: {
		icon: MinusIcon,
		color: 'var(--status-critical)',
		hint: 'Row removed — only the previous values were captured',
	},
	TRUNCATE: {
		icon: EraserIcon,
		color: 'var(--status-serious)',
		hint: 'Table truncated — recorded as a marker with no row data',
	},
}

export function OperationBadge({ operation }: { operation: Operation }) {
	const style = OPERATION_STYLE[operation]
	return (
		<StatusChip
			icon={style.icon}
			label={operation}
			color={style.color}
			title={style.hint}
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
