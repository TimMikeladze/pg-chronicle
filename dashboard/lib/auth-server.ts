import 'server-only'

import { cookies } from 'next/headers'

import {
	anonymousAccessAllowed,
	dashboardPassword,
	SESSION_COOKIE,
	sessionIsValid,
} from './auth'

/**
 * Whether the current request may see the application chrome.
 *
 * Kept out of `lib/auth.ts` because that module also runs in middleware on the
 * Edge runtime, where `next/headers` is not available.
 *
 * The middleware is what actually enforces access; this is for rendering
 * decisions — chiefly not printing the audited table names into the nav of a
 * page a signed-out visitor can reach.
 */
export async function isSignedIn(): Promise<boolean> {
	if (!dashboardPassword()) return anonymousAccessAllowed()
	const store = await cookies()
	return sessionIsValid(store.get(SESSION_COOKIE)?.value)
}

/** True when this deployment has a password, i.e. signing out is meaningful. */
export function loginEnabled(): boolean {
	return Boolean(dashboardPassword())
}
