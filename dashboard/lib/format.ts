/**
 * Compact figures for stat tiles: 1,284 / 12.9K / 4.2M. Standalone values use
 * the font's proportional figures; only table columns get tabular-nums.
 */
export function compactNumber(value: number): string {
	if (!Number.isFinite(value)) return '—'
	if (Math.abs(value) < 10_000) return value.toLocaleString('en-US')
	return new Intl.NumberFormat('en-US', {
		notation: 'compact',
		maximumFractionDigits: 1,
	}).format(value)
}

export function exactNumber(value: number): string {
	return Number.isFinite(value) ? value.toLocaleString('en-US') : '—'
}

const RELATIVE = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })

const DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> =
	[
		{ amount: 60, unit: 'second' },
		{ amount: 60, unit: 'minute' },
		{ amount: 24, unit: 'hour' },
		{ amount: 7, unit: 'day' },
		{ amount: 4.34524, unit: 'week' },
		{ amount: 12, unit: 'month' },
		{ amount: Number.POSITIVE_INFINITY, unit: 'year' },
	]

/** "3 minutes ago" — for operational recency, where the exact instant is secondary. */
export function relativeTime(iso: string | null | undefined): string {
	if (!iso) return 'never'
	const timestamp = new Date(iso).getTime()
	if (Number.isNaN(timestamp)) return '—'

	let duration = (timestamp - Date.now()) / 1000
	for (const division of DIVISIONS) {
		if (Math.abs(duration) < division.amount) {
			return RELATIVE.format(Math.round(duration), division.unit)
		}
		duration /= division.amount
	}
	return '—'
}

/** Full timestamp for the audit trail itself, where precision is the point. */
export function absoluteTime(iso: string | null | undefined): string {
	if (!iso) return '—'
	const date = new Date(iso)
	if (Number.isNaN(date.getTime())) return '—'
	return date.toLocaleString('en-US', {
		year: 'numeric',
		month: 'short',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
		hour12: false,
	})
}

/** Truncates long identifiers/values for dense table cells without hiding the full value. */
export function truncate(value: string, max = 48): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`
}
