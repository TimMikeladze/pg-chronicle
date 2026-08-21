'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import {
	type ConnectionFormState,
	parseConnectionForm,
} from '@/lib/connection-input'
import { forgetConnection, verifyConnection } from '@/lib/connection-runtime'
import {
	createConnection,
	DuplicateConnectionError,
	deleteConnection,
	getConnection,
	getConnectionDraft,
	updateConnection,
} from '@/lib/registry'
import { SecretKeyMismatchError } from '@/lib/secret-box'

/**
 * Managing the set of databases the dashboard knows about.
 *
 * These are the only actions that write credentials, so they are the only place
 * that has to be careful about what comes back out: a failure message is
 * rendered in the browser, and the underlying errors here can quote a
 * connection string. Every message returned to the caller is either one this
 * file wrote or one narrowed to the database's own complaint.
 */

/**
 * Postgres and pg-chronicle errors are safe to show — they name the real
 * problem ("password authentication failed", "relation does not exist"), which
 * is the whole value of verifying before saving. Anything else is logged and
 * generalised.
 */
function describeFailure(error: unknown): string {
	if (error instanceof DuplicateConnectionError) return error.message
	if (error instanceof Error && error.message) {
		// Never echo a connection string back into the page.
		return error.message.replace(
			/postgres(ql)?:\/\/\S+/gi,
			'<connection string>',
		)
	}
	console.error('connection action failed', error)
	return 'Could not reach that database.'
}

export async function createConnectionAction(
	_previous: ConnectionFormState,
	form: FormData,
): Promise<ConnectionFormState> {
	const parsed = parseConnectionForm(form)
	if (!parsed.ok) return { error: parsed.message }

	try {
		// Before writing anything: prove the credentials work and install the
		// audit triggers. A registry full of connections that were never reachable
		// is worse than a form that refused to submit.
		await verifyConnection(parsed.value)
		await createConnection(parsed.value)
	} catch (error) {
		return { error: describeFailure(error) }
	}

	revalidatePath('/connections')
	revalidatePath('/', 'layout')
	redirect('/connections')
}

export async function updateConnectionAction(
	id: string,
	_previous: ConnectionFormState,
	form: FormData,
): Promise<ConnectionFormState> {
	if (!(await getConnectionDraft(id))) {
		return { error: 'That connection no longer exists.' }
	}

	/*
	 * The decrypted connection is loaded only to let blank fields mean "leave
	 * unchanged". When the secret has been rotated it cannot be loaded at all,
	 * and the form correctly falls back to requiring the credentials afresh —
	 * which is the only way to repair such a row anyway.
	 */
	let existing: Awaited<ReturnType<typeof getConnection>> = null
	try {
		existing = await getConnection(id)
	} catch (error) {
		if (!(error instanceof SecretKeyMismatchError)) throw error
	}

	const parsed = parseConnectionForm(form, existing ?? undefined)
	if (!parsed.ok) return { error: parsed.message }

	try {
		await verifyConnection(parsed.value)
		await updateConnection(id, parsed.value)
	} catch (error) {
		return { error: describeFailure(error) }
	}

	// The cached server holds the old table allowlist and credentials. It is
	// rebuilt on the next request by fingerprint, but dropping it now means the
	// redirect below already renders the new configuration.
	await forgetConnection(id)

	revalidatePath('/connections')
	revalidatePath('/', 'layout')
	redirect('/connections')
}

/**
 * Removes the connection from the dashboard only. The audit triggers and the
 * recorded history stay exactly where they are — this is a bookmark being
 * deleted, not an audit trail.
 */
export async function deleteConnectionAction(id: string): Promise<void> {
	await deleteConnection(id)
	await forgetConnection(id)
	revalidatePath('/connections')
	revalidatePath('/', 'layout')
}
