'use server'

import { revalidatePath } from 'next/cache'

import {
	ApiError,
	getRecordHistory,
	revertEntry,
	runArchival,
	searchHistory,
} from '@/lib/pg-history-server'
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

export async function searchAction(
	params: SearchParams,
): Promise<ActionResult<PaginatedWire<AuditEntryWire>>> {
	return run(() => searchHistory(params))
}

export async function loadHistoryPageAction(input: {
	table: string
	recordId: string
	cursor?: string
	order: 'asc' | 'desc'
	limit: number
}): Promise<ActionResult<PaginatedWire<AuditEntryWire>>> {
	return run(() =>
		getRecordHistory(input.table, input.recordId, {
			limit: input.limit,
			cursor: input.cursor as HistoryCursor | undefined,
			order: input.order,
		}),
	)
}

export async function revertAction(input: {
	table: string
	recordId: string
	auditEntryId: string
	suppressAuditTriggers?: boolean
}): Promise<ActionResult<null>> {
	const result = await run(() => revertEntry(input))
	if (result.ok) {
		// The timeline gains a new entry for the revert itself, so the cached
		// render is stale the moment this succeeds.
		revalidatePath(`/history/${input.table}/${input.recordId}`)
		revalidatePath('/')
		return { ok: true, value: null }
	}
	return result
}

export async function runArchivalAction(): Promise<
	ActionResult<DetailedHealth['archival']>
> {
	const result = await run(() => runArchival())
	if (result.ok) {
		revalidatePath('/')
		return { ok: true, value: result.value.archival }
	}
	return result
}

/**
 * Re-exported so client components get a typed cursor without importing the
 * branded type from a server-only module.
 */
export async function searchNextPageAction(
	params: SearchParams,
	cursor: string,
): Promise<ActionResult<PaginatedWire<AuditEntryWire>>> {
	return run(() => searchHistory({ ...params, cursor: cursor as SearchCursor }))
}
