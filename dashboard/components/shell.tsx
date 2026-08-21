import 'server-only'

import { Nav, type NavScope } from '@/components/nav'
import { HealthBadge } from '@/components/status'
import { isSignedIn, loginEnabled } from '@/lib/auth-server'
import { getHealth } from '@/lib/pg-chronicle-server'
import {
	type Connection,
	listConnections,
	registryConfigured,
} from '@/lib/registry'

/**
 * The application chrome: the bar plus the page gutter.
 *
 * Both the connection-scoped pages and the management pages render it, which is
 * why it lives here rather than in a layout — the connection switcher has to be
 * present on both, and the two route trees have no common layout below the root.
 */
export async function Shell({
	connection,
	children,
}: {
	/** The connection this page reads, or null on the management pages. */
	connection?: Connection | null
	children: React.ReactNode
}) {
	// The sign-in page is reachable without a session, and the bar would print
	// connection names and live health into it. Withhold the chrome until the
	// visitor is through the gate.
	const signedIn = await isSignedIn()

	/*
	 * A registry that cannot be read must not blank the page: the pages below
	 * explain the problem far better than a bare error, and one of them is the
	 * form for fixing it.
	 */
	const connections = registryConfigured()
		? await listConnections().catch(() => [])
		: []

	const scope: NavScope | null = connection
		? { id: connection.id, name: connection.name, tables: connection.tables }
		: null

	const health = signedIn && connection ? await getHealth(connection) : null

	return (
		<>
			{signedIn ? (
				<Nav
					connections={connections.map(({ id, name }) => ({ id, name }))}
					scope={scope}
					health={
						connection ? (
							<HealthBadge status={health?.status ?? 'error'} />
						) : undefined
					}
					canSignOut={loginEnabled()}
				/>
			) : null}
			{/* Wider than a prose column: the results table carries seven columns of
			    identifiers, and cramping them forced truncation that hid the values
			    an auditor came to read. */}
			<main className="mx-auto w-full max-w-[1400px] px-6 py-8">
				{children}
			</main>
		</>
	)
}
