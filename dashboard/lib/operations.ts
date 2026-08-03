import type * as React from 'react'

import type { Operation } from './types'

/**
 * The product's entire color vocabulary lives here: one hue per audited
 * operation, resolved from the four `--op-*` custom properties. Every surface
 * that shows an operation — badge, rail, timeline node, diff gutter — reads
 * from this map, so a hue always means the same thing in every context.
 *
 * `verb` is what the database did, phrased from the row's point of view; the
 * operation name itself is SQL, which is correct for an audit trail but tells a
 * reader nothing about consequence.
 */
export interface OperationMeta {
	/** CSS custom property reference — never a literal, so themes stay in sync. */
	color: string
	/** Past-tense description of the effect on the row. */
	verb: string
	/** What the trigger actually captured, which governs what a diff can show. */
	captured: string
}

export const OPERATION_META: Record<Operation, OperationMeta> = {
	INSERT: {
		color: 'var(--op-insert)',
		verb: 'Row created',
		captured: 'Only new values were captured — there is no before state.',
	},
	UPDATE: {
		color: 'var(--op-update)',
		verb: 'Row modified',
		captured: 'Both the before and after values were captured.',
	},
	DELETE: {
		color: 'var(--op-delete)',
		verb: 'Row removed',
		captured:
			'Only the previous values were captured — there is no after state.',
	},
	TRUNCATE: {
		color: 'var(--op-truncate)',
		verb: 'Table truncated',
		captured:
			'Recorded as a statement-level marker. TRUNCATE carries no row payload, so there is nothing to compare or restore.',
	},
}

export function operationColor(operation: Operation): string {
	return OPERATION_META[operation]?.color ?? 'var(--muted-foreground)'
}

/**
 * Inline style that paints the signature rail. Kept as a helper so the custom
 * property name is written once — `.op-rail` in globals.css reads `--rail-color`.
 */
export function railStyle(operation: Operation): React.CSSProperties {
	return { '--rail-color': operationColor(operation) } as React.CSSProperties
}

/** Border + tint pair used by chips and callouts, at the two standard mixes. */
export function tintStyle(
	color: string,
	{ border = 40, fill = 10 }: { border?: number; fill?: number } = {},
): React.CSSProperties {
	return {
		borderColor: `color-mix(in srgb, ${color} ${border}%, transparent)`,
		backgroundColor: `color-mix(in srgb, ${color} ${fill}%, transparent)`,
	}
}
