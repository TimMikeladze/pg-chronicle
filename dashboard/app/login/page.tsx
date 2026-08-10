import { LockIcon } from 'lucide-react'

import { LoginForm } from '@/components/login-form'
import { anonymousAccessAllowed, dashboardPassword } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export const metadata = {
	title: 'Sign in · pg-history',
}

export default async function LoginPage({
	searchParams,
}: {
	searchParams: Promise<{ next?: string }>
}) {
	const { next } = await searchParams
	const configured = Boolean(dashboardPassword())

	return (
		<div className="mx-auto flex max-w-md flex-col gap-5 py-16">
			<div className="flex items-center gap-2">
				<LockIcon className="text-muted-foreground size-4 shrink-0" />
				<h1 className="text-ink text-lg font-semibold tracking-tight">
					Sign in
				</h1>
			</div>

			{configured ? (
				<>
					<p className="text-muted-foreground text-[13px] leading-relaxed">
						This dashboard can read every audited record and revert them, so it
						is password-protected.
					</p>
					<LoginForm next={next} />
				</>
			) : (
				<div className="flex flex-col gap-4">
					<p className="text-muted-foreground text-[13px] leading-relaxed">
						No dashboard password is configured, so there is nothing to sign in
						with.{' '}
						{anonymousAccessAllowed()
							? 'Anonymous access is currently allowed — go straight to the dashboard.'
							: 'The dashboard is refusing to serve pages until one is set.'}
					</p>
					<pre className="bg-inset overflow-x-auto rounded-lg border p-4 font-mono text-xs leading-relaxed">
						{'PG_HISTORY_DASHBOARD_PASSWORD=a-long-random-string'}
					</pre>
					<p className="text-muted-foreground text-[13px] leading-relaxed">
						Already behind an SSO or access proxy? Set{' '}
						<code className="text-foreground font-mono text-xs">
							PG_HISTORY_DASHBOARD_ALLOW_ANONYMOUS=true
						</code>{' '}
						instead to acknowledge that something else authenticates these
						requests.
					</p>
				</div>
			)}
		</div>
	)
}
