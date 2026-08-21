import { ConnectionForm } from '@/components/connection-form'
import { RegistryNotConfigured } from '@/components/not-configured'
import { registryConfigured } from '@/lib/registry'

import { createConnectionAction } from '../actions'

export const dynamic = 'force-dynamic'

export const metadata = {
	title: 'Add a connection · pg-chronicle',
}

export default function NewConnectionPage() {
	if (!registryConfigured()) return <RegistryNotConfigured />

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
			<div className="flex flex-col gap-2">
				<h1 className="text-ink text-2xl font-semibold tracking-tight">
					Add a connection
				</h1>
				<p className="text-muted-foreground text-[13px] leading-relaxed">
					The dashboard connects, installs the audit triggers on the tables you
					list, and starts recording. Nothing is saved until that succeeds.
				</p>
			</div>

			<ConnectionForm
				action={createConnectionAction}
				submitLabel="Add connection"
			/>
		</div>
	)
}
