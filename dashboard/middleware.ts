import { type NextRequest, NextResponse } from 'next/server'

import {
	anonymousAccessAllowed,
	dashboardPassword,
	isPublicPath,
	SESSION_COOKIE,
	sessionIsValid,
} from '@/lib/auth'

/**
 * Gate every dashboard page behind the shared password.
 *
 * Reaching a page means full audit read plus revert — the dashboard signs its
 * own API token, so there is no second checkpoint further in. This middleware
 * is the only thing standing between a public URL and an anonymous revert
 * button, which is why it fails closed in production.
 *
 * Not gated: `/api/*` (the real REST API, already behind its own JWT / cron
 * secret and called by schedulers), `/health`, `/login`, and static assets.
 */
export async function middleware(request: NextRequest) {
	const { pathname, search } = request.nextUrl

	if (isPublicPath(pathname)) return NextResponse.next()

	const password = dashboardPassword()

	if (!password) {
		if (anonymousAccessAllowed()) return NextResponse.next()
		// Production with no password and no explicit opt-out. Serving the UI here
		// would publish an anonymous revert button, so refuse and say exactly what
		// to set.
		return new NextResponse(
			'pg-history dashboard is not configured for public access.\n\n' +
				'Set PG_HISTORY_DASHBOARD_PASSWORD to require a login, or set\n' +
				'PG_HISTORY_DASHBOARD_ALLOW_ANONYMOUS=true if this deployment is already\n' +
				'behind an access proxy that authenticates every request.\n\n' +
				'Refusing to serve the UI: reaching it grants full audit-history read\n' +
				'access and the ability to revert records.',
			{ status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } },
		)
	}

	if (await sessionIsValid(request.cookies.get(SESSION_COOKIE)?.value)) {
		return NextResponse.next()
	}

	// A server action arrives as a POST to the page's own URL. Redirecting it
	// would send the action body to /login, which cannot handle it — the caller
	// gets an opaque failure instead of "your session expired". Answer plainly;
	// the next navigation hits the redirect below and shows the login page.
	if (request.method !== 'GET' && request.method !== 'HEAD') {
		return new NextResponse('Dashboard session expired. Sign in again.', {
			status: 401,
			headers: { 'content-type': 'text/plain; charset=utf-8' },
		})
	}

	const loginUrl = new URL('/login', request.url)
	// Round-trip the original destination so a bookmarked deep link survives
	// the login. Only the path is carried over — never an absolute URL, which
	// would make this an open redirect.
	if (pathname !== '/')
		loginUrl.searchParams.set('next', `${pathname}${search}`)
	return NextResponse.redirect(loginUrl)
}

export const config = {
	/*
	 * Everything except Next's own asset routes. `/api` is excluded inside the
	 * middleware rather than here so the reasoning lives next to the rule.
	 */
	matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
}
