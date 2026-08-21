import { redirect } from 'next/navigation'

import { listConnections, registryConfigured } from '@/lib/registry'

export const dynamic = 'force-dynamic'

/**
 * The root has no content of its own — every view belongs to a connection.
 *
 * With exactly one connection configured (the common case) it lands straight on
 * that connection's overview, so the multi-database structure costs a
 * single-database deployment nothing. Otherwise it goes to the list, which is
 * both the chooser and the place to add another.
 */
export default async function RootPage() {
	if (!registryConfigured()) redirect('/connections')

	const connections = await listConnections().catch(() => [])
	const only = connections.length === 1 ? connections[0] : undefined

	if (only && !only.sealed) redirect(`/c/${encodeURIComponent(only.id)}`)
	redirect('/connections')
}
