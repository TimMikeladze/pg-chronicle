import { notFound, redirect } from 'next/navigation'

import { ConnectionProvider } from '@/components/connection-context'
import { Shell } from '@/components/shell'
import { loadConnection } from '@/lib/current-connection'
import { getConnectionDraft } from '@/lib/registry'
import { SecretKeyMismatchError } from '@/lib/secret-box'

/**
 * Every page under `/c/<connection>` reads one database, named in the URL.
 *
 * The connection is resolved once here and handed to the pages through
 * `params`, which they re-resolve from the same cached registry read. What this
 * layout owns is the two failure modes that must never reach a page: a
 * connection that no longer exists, and one whose credentials cannot be
 * decrypted — rendering an audit trail is meaningless in both cases, and the
 * second has a specific remedy that belongs on the edit form.
 */
export default async function ConnectionLayout({
	children,
	params,
}: {
	children: React.ReactNode
	params: Promise<{ conn: string }>
}) {
	const { conn } = await params

	let connection: Awaited<ReturnType<typeof loadConnection>>
	try {
		connection = await loadConnection(conn)
	} catch (error) {
		if (!(error instanceof SecretKeyMismatchError)) throw error
		// The row exists but is unreadable. The edit form is the only place this
		// can be fixed, and it explains why it is asking.
		redirect(`/connections/${encodeURIComponent(conn)}`)
	}

	if (!connection) {
		// Distinguish "never existed" from "unreadable": a stale bookmark to a
		// removed connection is a 404, not a repair job.
		if (await getConnectionDraft(conn)) {
			redirect(`/connections/${encodeURIComponent(conn)}`)
		}
		notFound()
	}

	return (
		<ConnectionProvider id={connection.id}>
			<Shell connection={connection}>{children}</Shell>
		</ConnectionProvider>
	)
}
