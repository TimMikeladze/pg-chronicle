'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { ThemeToggle } from '@/components/theme-toggle'
import { cn } from '@/lib/utils'

const LINKS = [
	{ href: '/', label: 'Overview' },
	{ href: '/search', label: 'Explore' },
]

export function Nav() {
	const pathname = usePathname()

	return (
		<header className="bg-background/80 sticky top-0 z-40 border-b backdrop-blur">
			<div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
				<Link
					href="/"
					className="text-ink font-display text-sm font-semibold tracking-tight"
				>
					pg-history
				</Link>

				<nav className="flex items-center gap-1">
					{LINKS.map((link) => {
						const active =
							link.href === '/'
								? pathname === '/'
								: pathname.startsWith(link.href)
						return (
							<Link
								key={link.href}
								href={link.href}
								aria-current={active ? 'page' : undefined}
								className={cn(
									'rounded-md px-3 py-1.5 text-sm transition-colors',
									active
										? 'bg-inset text-ink font-medium'
										: 'text-muted-foreground hover:text-foreground',
								)}
							>
								{link.label}
							</Link>
						)
					})}
				</nav>

				<div className="ml-auto flex items-center gap-1">
					{/*
					 * Plain anchor, not next/link: this is a JSON route, not a page —
					 * a client-side navigation would try to render it as one.
					 */}
					<a
						href="/openapi"
						className="text-muted-foreground hover:text-foreground rounded-md px-3 py-1.5 text-sm transition-colors"
					>
						API spec
					</a>
					<ThemeToggle />
				</div>
			</div>
		</header>
	)
}
