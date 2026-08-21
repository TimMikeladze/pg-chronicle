'use client'

import { createContext, useContext } from 'react'

/**
 * Which database the client components on this page are acting on.
 *
 * Every server action that reads or reverts takes a connection id, because the
 * deployment manages several and an audit tool that could act on the wrong one
 * is worse than no tool. Threading that id as a prop through the diff viewer,
 * the timeline and the revert dialog would put it in the signature of half the
 * component tree; the route segment already establishes it, so the layout that
 * owns the segment publishes it here instead.
 */
const ConnectionContext = createContext<string | null>(null)

export function ConnectionProvider({
	id,
	children,
}: {
	id: string
	children: React.ReactNode
}) {
	return (
		<ConnectionContext.Provider value={id}>
			{children}
		</ConnectionContext.Provider>
	)
}

export function useConnectionId(): string {
	const id = useContext(ConnectionContext)
	if (id === null) {
		throw new Error(
			'useConnectionId must be used inside a connection-scoped route (/c/<connection>/…).',
		)
	}
	return id
}

/** `/c/<connection>` — the prefix every in-app link on these pages carries. */
export function useConnectionPath(): string {
	return `/c/${encodeURIComponent(useConnectionId())}`
}
