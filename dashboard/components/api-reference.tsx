'use client'

import { ApiReferenceReact } from '@scalar/api-reference-react'
import '@scalar/api-reference-react/style.css'
import { useTheme } from 'next-themes'

/**
 * Renders the pg-history OpenAPI document as a browsable reference.
 *
 * The spec is passed in as `content` rather than fetched by URL: the library
 * serves `/openapi` behind the same JWT as the rest of the API, so the browser
 * cannot reach it. The server component already holds the document — handing it
 * over directly also saves the round trip.
 *
 * Scalar keeps its own light/dark state, so `forceDarkModeState` slaves it to
 * the dashboard's theme and the built-in toggle is hidden; two toggles that
 * disagree is worse than one that works.
 */
export function ApiReference({ spec }: { spec: Record<string, unknown> }) {
	const { resolvedTheme } = useTheme()

	return (
		<ApiReferenceReact
			configuration={{
				content: spec,
				// `none` opts out of Scalar's own palettes so the CSS overrides in
				// globals.css can map it onto the dashboard's tokens.
				theme: 'none',
				layout: 'modern',
				forceDarkModeState: resolvedTheme === 'light' ? 'light' : 'dark',
				hideDarkModeToggle: true,
				// The document lives at a stable URL of its own; Scalar's download
				// button would offer a second, differently-named copy of it.
				hideDownloadButton: true,
				withDefaultFonts: false,
				// Requests go to the dashboard's own proxy, which attaches the JWT —
				// same path every page here already uses.
				baseServerURL: '/api',
			}}
		/>
	)
}
