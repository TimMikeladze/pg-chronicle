'use server'

import { revalidatePath } from 'next/cache'
import {
	ApiError,
	getRecordHistory,
	revertEntry,
	runArchival,
	searchHistory,
} from '@/lib/pg-chronicle-server'
import { type Connection, getConnection } from '@/lib/registry'
import type {
	ActionResult,
	AuditEntryWire,
	DetailedHealth,
	HistoryCursor,
	PaginatedWire,
	SearchCursor,
	SearchParams,
} from '@/lib/types'

/**
 * Every action names the connection it acts on. There is no ambient "current
 * database" the browser can rely on: the id travels in the payload, is resolved
 * against the registry server-side, and a request naming an unknown connection
 * is refused rather than falling back to a default. On a tool whose most
 * consequential action is `revert`, guessing is not an option.
 */

/**
 * Server actions cannot reject with a rich error across the RSC boundary, so
 * every failure is normalised into data. `ApiError` already carries the API's
 * own code, which the UI maps to a message the operator can act on.
 */
async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
	try {
		return { ok: true, value: await fn() }
	} catch (error) {
		if (error instanceof ApiError) {
			return { ok: false, code: error.code, message: error.message }
		}
		// Never leak an internal message (connection strings, env var names) to
		// the browser — the real error is logged server-side.
		console.error('dashboard action failed', error)
		return {
			ok: false,
			code: 'DATABASE_ERROR',
			message: 'Something went wrong reaching the audit log.',
		}
	}
}

/**
 * Resolve a connection or fail the action. Decryption failures land here too
 * and are reported as NOT_CONFIGURED rather than crashing the action.
 */
async function withConnection<T>(
	connectionId: string,
	fn: (connection: Connection) => Promise<T>,
): Promise<ActionResult<T>> {
	return run(async () => {
		const connection = await getConnection(connectionId)
		if (!connection) {
			throw new ApiError(
				'NOT_CONFIGURED',
				'That connection is no longer configured on this dashboard.',
				404,
			)
		}
		return fn(connection)
	})
}

export async function searchAction(
	connectionId: string,
	params: SearchParams,
): Promise<ActionResult<PaginatedWire<AuditEntryWire>>> {
	return withConnection(connectionId, (connection) =>
		searchHistory(connection, params),
	)
}

export async function searchNextPageAction(
	connectionId: string,
	params: SearchParams,
	cursor: string,
): Promise<ActionResult<PaginatedWire<AuditEntryWire>>> {
	return withConnection(connectionId, (connection) =>
		searchHistory(connection, { ...params, cursor: cursor as SearchCursor }),
	)
}

export async function loadHistoryPageAction(input: {
	connectionId: string
	table: string
	recordId: string
	cursor?: string
	order: 'asc' | 'desc'
	limit: number
}): Promise<ActionResult<PaginatedWire<AuditEntryWire>>> {
	return withConnection(input.connectionId, (connection) =>
		getRecordHistory(connection, input.table, input.recordId, {
			limit: input.limit,
			cursor: input.cursor as HistoryCursor | undefined,
			order: input.order,
		}),
	)
}

export async function revertAction(input: {
	connectionId: string
	table: string
	recordId: string
	auditEntryId: string
	suppressAuditTriggers?: boolean
}): Promise<ActionResult<null>> {
	const result = await withConnection(input.connectionId, (connection) =>
		revertEntry(connection, input),
	)
	if (result.ok) {
		const prefix = `/c/${input.connectionId}`
		// The timeline gains a new entry for the revert itself, so the cached
		// render is stale the moment this succeeds.
		revalidatePath(`${prefix}/history/${input.table}/${input.recordId}`)
		revalidatePath(prefix)
		return { ok: true, value: null }
	}
	return result
}

export async function runArchivalAction(
	connectionId: string,
): Promise<ActionResult<DetailedHealth['archival']>> {
	const result = await withConnection(connectionId, (connection) =>
		runArchival(connection),
	)
	if (result.ok) {
		revalidatePath(`/c/${connectionId}/archival`)
		return { ok: true, value: result.value.archival }
	}
	return result
}
