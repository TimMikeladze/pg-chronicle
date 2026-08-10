'use server'

import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'

import {
	createSessionToken,
	dashboardPassword,
	SESSION_COOKIE,
	secretsMatch,
} from '@/lib/auth'
import {
	checkThrottle,
	recordFailure,
	recordSuccess,
} from '@/lib/login-throttle'

/**
 * Best-effort client identity for throttling. A server action has no socket to
 * read, so this is whatever the platform put in front of us — present on
 * Vercel and behind any normal proxy, absent otherwise. `undefined` is handled
 * by the throttle as "delay but never lock out".
 */
async function clientIdentity(): Promise<string | undefined> {
	const headerList = await headers()
	const forwarded = headerList.get('x-forwarded-for')?.split(',')[0]?.trim()
	return forwarded || headerList.get('x-real-ip') || undefined
}

/**
 * Only ever redirect to a path on this deployment. Accepting the raw `next`
 * value would turn the login into an open redirect.
 */
function safeNext(value: FormDataEntryValue | null): string {
	if (typeof value !== 'string') return '/'
	if (!value.startsWith('/') || value.startsWith('//')) return '/'
	return value
}

export async function loginAction(
	_previous: { error?: string } | undefined,
	formData: FormData,
): Promise<{ error?: string }> {
	const expected = dashboardPassword()
	if (!expected) {
		return { error: 'No dashboard password is configured on this deployment.' }
	}

	const submitted = formData.get('password')
	if (typeof submitted !== 'string' || submitted.length === 0) {
		return { error: 'Enter the dashboard password.' }
	}

	const client = await clientIdentity()
	const throttle = checkThrottle(client)
	if (throttle.lockedOut) {
		// Refused without even comparing, so a locked-out client learns nothing
		// about the password from the response.
		await new Promise((resolve) => setTimeout(resolve, throttle.delayMs))
		return {
			error: `Too many failed attempts. Try again in ${throttle.retryAfterMinutes} minute${
				throttle.retryAfterMinutes === 1 ? '' : 's'
			}.`,
		}
	}

	if (!(await secretsMatch(submitted, expected))) {
		recordFailure(client)
		// Escalating delay: one shared password means there is no account to lock,
		// so the cost of a guess has to come from the clock.
		await new Promise((resolve) => setTimeout(resolve, throttle.delayMs))
		return { error: 'Incorrect password.' }
	}

	recordSuccess(client)
	const { token, maxAge } = await createSessionToken(expected)
	const store = await cookies()
	store.set(SESSION_COOKIE, token, {
		httpOnly: true,
		sameSite: 'lax',
		// Secure everywhere except local http development, where it would prevent
		// the cookie from ever being stored.
		secure: process.env.NODE_ENV === 'production',
		path: '/',
		maxAge,
	})

	redirect(safeNext(formData.get('next')))
}

export async function logoutAction(): Promise<void> {
	const store = await cookies()
	store.delete(SESSION_COOKIE)
	redirect('/login')
}
