import type { Metadata } from 'next'

import '@fontsource/geist-sans/400.css'
import '@fontsource/geist-sans/500.css'
import '@fontsource/geist-sans/600.css'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import './globals.css'

import { Nav } from '@/components/nav'
import { HealthBadge } from '@/components/status'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'
import { isSignedIn, loginEnabled } from '@/lib/auth-server'
import { readConfig } from '@/lib/config'
import { getHealth } from '@/lib/pg-history-server'

export const metadata: Metadata = {
	title: 'pg-history',
	description: 'Browse, search, and revert the PostgreSQL audit trail.',
}

export default async function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	// Audited tables and API health are true on every page, so the layout reads
	// them once and the bar renders them once. Pages no longer restate either.
	const config = readConfig()
	// The sign-in page is reachable without a session, and the nav would print
	// the audited table names and live health into it. Withhold the chrome until
	// the visitor is through the gate.
	const signedIn = await isSignedIn()
	const health = signedIn ? await getHealth() : null

	return (
		<html lang="en" suppressHydrationWarning>
			<body className="min-h-screen">
				<ThemeProvider
					attribute="class"
					defaultTheme="dark"
					enableSystem
					disableTransitionOnChange
				>
					<TooltipProvider delayDuration={200}>
						{signedIn ? (
							<Nav
								tables={config.tables}
								health={<HealthBadge status={health?.status ?? 'error'} />}
								canSignOut={loginEnabled()}
							/>
						) : null}
						{/* Wider than a prose column: the results table carries seven
						    columns of identifiers, and cramping them forced truncation
						    that hid the values an auditor came to read. */}
						<main className="mx-auto w-full max-w-[1400px] px-6 py-8">
							{children}
						</main>
						<Toaster position="bottom-right" />
					</TooltipProvider>
				</ThemeProvider>
			</body>
		</html>
	)
}
