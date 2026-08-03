'use client'

import {
	ChevronRightIcon,
	DatabaseIcon,
	SearchIcon,
	TableIcon,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { ThemeToggle } from '@/components/theme-toggle'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

const SECTIONS = [
	{ href: '/', label: 'Overview', match: (p: string) => p === '/' },
	{
		href: '/tables',
		label: 'Tables',
		match: (p: string) => p.startsWith('/tables') || p.startsWith('/history'),
	},
	{ href: '/search', label: 'Explore', match: (p: string) => p === '/search' },
	{
		href: '/archival',
		label: 'Archival',
		match: (p: string) => p.startsWith('/archival'),
	},
]

/**
 * The mark: three bars of unequal length, shortest first — three audit entries
 * stacked in time. It reads as a timeline at 16px, which is all a mark this
 * size has to do.
 */
function Mark() {
	return (
		// Decorative: the "pghistory" wordmark sits beside it and carries the
		// name, so the glyph is hidden from assistive tech rather than given a
		// label that would be read out twice.
		<svg
			viewBox="0 0 16 16"
			role="presentation"
			aria-hidden="true"
			className="size-4 shrink-0"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
		>
			<path d="M3 4h6M3 8h10M3 12h7" />
		</svg>
	)
}

/**
 * The scope switcher. Which tables are audited is global state that every page
 * reads, so it lives in the bar exactly once — instead of being restated as a
 * chip list on the overview, a toggle row in search, and a select in the
 * jump-to-record form.
 */
function TableSwitcher({ tables }: { tables: string[] }) {
	const pathname = usePathname()
	// On a table-scoped route the bar names the table being viewed; elsewhere it
	// reports the size of the audited set.
	const segments = pathname.split('/')
	const active =
		pathname.startsWith('/tables/') || pathname.startsWith('/history/')
			? decodeURIComponent(segments[2] ?? '')
			: null

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground hover:bg-inset flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[13px] transition-colors"
				>
					<DatabaseIcon className="size-3.5 shrink-0" />
					{active || `${tables.length} tables`}
					<ChevronRightIcon className="size-3 rotate-90 opacity-60" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56">
				<DropdownMenuLabel className="eyebrow">
					Audited tables
				</DropdownMenuLabel>
				{tables.map((table) => (
					<DropdownMenuItem key={table} asChild>
						<Link
							href={`/tables/${encodeURIComponent(table)}`}
							className="cursor-pointer font-mono text-xs"
						>
							<TableIcon className="size-3.5 opacity-60" />
							{table}
						</Link>
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuItem asChild>
					<Link href="/tables" className="cursor-pointer text-xs">
						All tables
					</Link>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export function Nav({
	tables,
	health,
}: {
	tables: string[]
	/** Rendered by the bar so no page carries a status badge of its own. */
	health?: React.ReactNode
}) {
	const pathname = usePathname()
	const openApiActive = pathname.startsWith('/openapi')

	return (
		<header className="bg-background/80 sticky top-0 z-40 backdrop-blur-md">
			{/*
			 * Two tiers matching what is being navigated: identity plus global state
			 * on top, sections below. Everything in the top tier is true on every
			 * page — which is what earns it a permanent slot.
			 */}
			<div className="mx-auto flex h-14 w-full max-w-[1400px] items-center gap-2 px-6">
				<Link
					href="/"
					className="text-ink hover:text-ink/80 flex shrink-0 items-center gap-2 text-[15px] font-semibold tracking-tight transition-colors"
				>
					<Mark />
					pghistory
				</Link>

				{tables.length > 0 ? (
					<>
						<span aria-hidden className="text-border shrink-0 select-none">
							/
						</span>
						<TableSwitcher tables={tables} />
					</>
				) : null}

				<div className="ml-auto flex shrink-0 items-center gap-1.5">
					{health}
					<Button asChild variant="ghost" size="sm">
						<Link href="/search">
							<SearchIcon />
							<span className="hidden sm:inline">Search</span>
						</Link>
					</Button>
					<ThemeToggle />
				</div>
			</div>

			<nav className="border-border border-b">
				<div className="mx-auto flex w-full max-w-[1400px] items-center gap-1 overflow-x-auto px-6">
					{SECTIONS.map((section) => {
						const active = section.match(pathname)
						return (
							<Link
								key={section.href}
								href={section.href}
								aria-current={active ? 'page' : undefined}
								className={cn(
									'relative shrink-0 px-3 py-2.5 text-[13px] transition-colors',
									active
										? 'text-ink font-medium'
										: 'text-muted-foreground hover:text-foreground',
								)}
							>
								{section.label}
								{/* Overlaps the bar's bottom hairline by design — the active
								    tab visually joins the content it heads. */}
								{active ? (
									<span
										aria-hidden
										className="bg-ink absolute inset-x-2 -bottom-px h-px"
									/>
								) : null}
							</Link>
						)
					})}

					{/*
					 * Sits apart from the sections: the reference documents the API the
					 * other four pages are built on, rather than being another view of
					 * the audit trail. The raw document stays at /openapi.json.
					 */}
					<Link
						href="/openapi"
						aria-current={openApiActive ? 'page' : undefined}
						className={cn(
							'relative ml-auto shrink-0 px-3 py-2.5 font-mono text-[13px] transition-colors',
							openApiActive
								? 'text-ink font-medium'
								: 'text-muted-foreground hover:text-foreground',
						)}
					>
						OpenAPI
						{openApiActive ? (
							<span
								aria-hidden
								className="bg-ink absolute inset-x-2 -bottom-px h-px"
							/>
						) : null}
					</Link>
				</div>
			</nav>
		</header>
	)
}
