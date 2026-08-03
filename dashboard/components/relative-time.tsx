'use client'

import { useEffect, useState } from 'react'

import { absoluteTime, relativeTime } from '@/lib/format'

/**
 * "3 minutes ago", rendered without a hydration mismatch.
 *
 * `relativeTime` reads `Date.now()`, so the server's string and the client's
 * differ by however long the response took — enough that React discards the
 * server tree and re-renders the whole page on every load. The fix is to render
 * a time-independent value on the server and swap after mount.
 *
 * The server value is the absolute timestamp rather than a blank: before
 * hydration the reader still sees when the change happened, which is the entire
 * job of the column.
 */
export function RelativeTime({
	iso,
	className,
}: {
	iso: string | null | undefined
	className?: string
}) {
	// Incremented on a timer purely to re-run the render; relative labels go
	// stale while an audit view sits open, and a minute is below the resolution
	// of every label past the first one.
	const [tick, setTick] = useState(0)

	useEffect(() => {
		setTick(1)
		const timer = setInterval(() => setTick((value) => value + 1), 60_000)
		return () => clearInterval(timer)
	}, [])

	return (
		<span className={className} title={absoluteTime(iso)}>
			{tick === 0 ? absoluteTime(iso) : relativeTime(iso)}
		</span>
	)
}
