import 'server-only'

import { notFound } from 'next/navigation'
import { cache } from 'react'

import { type Connection, getConnection } from './registry'

/**
 * The connection a `/c/<connection>` page is reading.
 *
 * Memoised per request with React's `cache`, because the layout and the page
 * both need it and a registry round-trip per server component would be one
 * query per panel on a page that renders several.
 *
 * The layout has already turned a missing or unreadable connection into a 404
 * or a redirect by the time a page calls this, so pages get a `Connection` and
 * not a union they would have to re-handle.
 */
export const loadConnection = cache(
	async (id: string): Promise<Connection | null> => getConnection(id),
)

export async function currentConnection(id: string): Promise<Connection> {
	const connection = await loadConnection(id)
	if (!connection) notFound()
	return connection
}
