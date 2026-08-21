import type { Metadata } from 'next'

import '@fontsource/geist-sans/400.css'
import '@fontsource/geist-sans/500.css'
import '@fontsource/geist-sans/600.css'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import './globals.css'

import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import { TooltipProvider } from '@/components/ui/tooltip'

export const metadata: Metadata = {
	title: 'pg-chronicle',
	description: 'Browse, search, and revert the PostgreSQL audit trail.',
}

/**
 * Providers only. The navigation bar names the database being read, which no
 * root layout can know — it belongs to the route segment that establishes it.
 * See `components/shell.tsx`, which the scoped and management layouts both use.
 */
export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
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
						{children}
						<Toaster position="bottom-right" />
					</TooltipProvider>
				</ThemeProvider>
			</body>
		</html>
	)
}
