import type { Metadata } from 'next'

import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import '@fontsource/martian-mono/600.css'
import './globals.css'

import { Nav } from '@/components/nav'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

export const metadata: Metadata = {
	title: 'pg-history',
	description: 'Browse, search, and revert the PostgreSQL audit trail.',
}

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<body>
				<ThemeProvider
					attribute="class"
					defaultTheme="system"
					enableSystem
					disableTransitionOnChange
				>
					<TooltipProvider>
						<Nav />
						<main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
						<Toaster position="bottom-right" />
					</TooltipProvider>
				</ThemeProvider>
			</body>
		</html>
	)
}
