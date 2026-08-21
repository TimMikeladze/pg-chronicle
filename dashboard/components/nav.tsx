'use client'

import {
	CheckIcon,
	ChevronRightIcon,
	DatabaseIcon,
	LogOutIcon,
	PlusIcon,
	SearchIcon,
	SettingsIcon,
	TableIcon,
} from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { logoutAction } from '@/app/login/actions'
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

export interface NavConnection {
	id: string
	name: string
}

/** The active connection's scope, absent on the connection-management pages. */
export interface NavScope {
	id: string
	name: string
	tables: string[]
}

const SECTIONS = [
	{ segment: '', label: 'Overview', match: (rest: string) => rest === '' },
	{
		segment: '/tables',
		label: 'Tables',
		match: (rest: string) =>
			rest.startsWith('/tables') || rest.startsWith('/history'),
	},
	{
		segment: '/search',
		label: 'Explore',
		match: (rest: string) => rest === '/search',
	},
	{
		segment: '/archival',
		label: 'Archival',
		match: (rest: string) => rest.startsWith('/archival'),
	},
]

/**
 * The mark: three bars of unequal length, shortest first — three audit entries
 * stacked in time. It reads as a timeline at 16px, which is all a mark this
 * size has to do.
 */
function Mark() {
	return (
		// Decorative: the "pg-chronicle" wordmark sits beside it and carries the
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
 * Which database is being read. This is the single most consequential piece of
 * state in the product — "revert this row" means nothing without it — so it
 * sits leftmost in the bar, is present on every scoped page, and names the
 * connection rather than counting anything.
 */
function ConnectionSwitcher({
	connections,
	active,
}: {
	connections: NavConnection[]
	active: NavScope | null
}) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="text-foreground hover:bg-inset flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] transition-colors"
				>
					<DatabaseIcon className="size-3.5 shrink-0 opacity-70" />
					{active?.name ?? 'All connections'}
					<ChevronRightIcon className="size-3 rotate-90 opacity-60" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-60">
				<DropdownMenuLabel className="eyebrow">Connections</DropdownMenuLabel>
				{connections.map((connection) => (
					<DropdownMenuItem key={connection.id} asChild>
						<Link
							href={`/c/${encodeURIComponent(connection.id)}`}
							className="cursor-pointer text-xs"
						>
							<CheckIcon
								className={cn(
									'size-3.5',
									connection.id === active?.id ? 'opacity-100' : 'opacity-0',
								)}
							/>
							{connection.name}
						</Link>
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuItem asChild>
					<Link href="/connections" className="cursor-pointer text-xs">
						<SettingsIcon className="size-3.5 opacity-60" />
						Manage connections
					</Link>
				</DropdownMenuItem>
				<DropdownMenuItem asChild>
					<Link href="/connections/new" className="cursor-pointer text-xs">
						<PlusIcon className="size-3.5 opacity-60" />
						Add a connection
					</Link>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

/**
 * The table scope, second in the bar because it only narrows what the
 * connection already established. Which tables are audited is global state that
 * every page reads, so it lives here exactly once instead of being restated as
 * a chip list on the overview, a toggle row in search, and a select in the
 * jump-to-record form.
 */
function TableSwitcher({ scope }: { scope: NavScope }) {
	const pathname = usePathname()
	const prefix = `/c/${encodeURIComponent(scope.id)}`
	const rest = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : ''
	// On a table-scoped route the bar names the table being viewed; elsewhere it
	// reports the size of the audited set.
	const segments = rest.split('/')
	const active =
		rest.startsWith('/tables/') || rest.startsWith('/history/')
			? decodeURIComponent(segments[2] ?? '')
			: null

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					className="text-muted-foreground hover:text-foreground hover:bg-inset flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[13px] transition-colors"
				>
					<TableIcon className="size-3.5 shrink-0" />
					{active || `${scope.tables.length} tables`}
					<ChevronRightIcon className="size-3 rotate-90 opacity-60" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-56">
				<DropdownMenuLabel className="eyebrow">
					Audited tables
				</DropdownMenuLabel>
				{scope.tables.map((table) => (
					<DropdownMenuItem key={table} asChild>
						<Link
							href={`${prefix}/tables/${encodeURIComponent(table)}`}
							className="cursor-pointer font-mono text-xs"
						>
							<TableIcon className="size-3.5 opacity-60" />
							{table}
						</Link>
					</DropdownMenuItem>
				))}
				<DropdownMenuSeparator />
				<DropdownMenuItem asChild>
					<Link href={`${prefix}/tables`} className="cursor-pointer text-xs">
						All tables
					</Link>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

export function Nav({
	connections,
	scope,
	health,
	canSignOut,
}: {
	/** Every managed connection, for the switcher. */
	connections: NavConnection[]
	/** The connection this page is scoped to, or null on the management pages. */
	scope: NavScope | null
	/** Rendered by the bar so no page carries a status badge of its own. */
	health?: React.ReactNode
	/** False when the deployment has no dashboard password to sign out of. */
	canSignOut?: boolean
}) {
	const pathname = usePathname()
	const prefix = scope ? `/c/${encodeURIComponent(scope.id)}` : null
	const rest =
		prefix && pathname.startsWith(prefix) ? pathname.slice(prefix.length) : null
	const openApiActive = rest === '/openapi'

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
					pg-chronicle
				</Link>

				<span aria-hidden className="text-border shrink-0 select-none">
					/
				</span>
				<ConnectionSwitcher connections={connections} active={scope} />

				{scope && scope.tables.length > 0 ? (
					<>
						<span aria-hidden className="text-border shrink-0 select-none">
							/
						</span>
						<TableSwitcher scope={scope} />
					</>
				) : null}

				<div className="ml-auto flex shrink-0 items-center gap-1.5">
					{health}
					{prefix ? (
						<Button asChild variant="ghost" size="sm">
							<Link href={`${prefix}/search`}>
								<SearchIcon />
								<span className="hidden sm:inline">Search</span>
							</Link>
						</Button>
					) : null}
					<ThemeToggle />
					{canSignOut ? (
						<form action={logoutAction}>
							<Button
								type="submit"
								variant="ghost"
								size="icon"
								title="Sign out"
							>
								<LogOutIcon />
								<span className="sr-only">Sign out</span>
							</Button>
						</form>
					) : null}
				</div>
			</div>

			<nav className="border-border border-b">
				<div className="mx-auto flex w-full max-w-[1400px] items-center gap-1 overflow-x-auto px-6">
					{prefix
						? SECTIONS.map((section) => {
								const active = rest !== null && section.match(rest)
								return (
									<Link
										key={section.segment || 'overview'}
										href={`${prefix}${section.segment}`}
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
							})
						: null}

					<Link
						href="/connections"
						aria-current={
							pathname.startsWith('/connections') ? 'page' : undefined
						}
						className={cn(
							'relative shrink-0 px-3 py-2.5 text-[13px] transition-colors',
							pathname.startsWith('/connections')
								? 'text-ink font-medium'
								: 'text-muted-foreground hover:text-foreground',
						)}
					>
						Connections
						{pathname.startsWith('/connections') ? (
							<span
								aria-hidden
								className="bg-ink absolute inset-x-2 -bottom-px h-px"
							/>
						) : null}
					</Link>

					{/*
					 * Sits apart from the sections: the reference documents the API the
					 * other pages are built on, rather than being another view of the
					 * audit trail. The raw document stays at <prefix>/openapi.json.
					 */}
					{prefix ? (
						<Link
							href={`${prefix}/openapi`}
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
					) : null}
				</div>
			</nav>
		</header>
	)
}
