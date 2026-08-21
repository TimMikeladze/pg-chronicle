import { notFound } from 'next/navigation'

import { ConnectionForm } from '@/components/connection-form'
import { RegistryNotConfigured } from '@/components/not-configured'
import { Callout } from '@/components/status'
import { getConnectionDraft, registryConfigured } from '@/lib/registry'

import { updateConnectionAction } from '../actions'

export const dynamic = 'force-dynamic'

export default async function EditConnectionPage({
	params,
}: {
	params: Promise<{ id: string }>
}) {
	if (!registryConfigured()) return <RegistryNotConfigured />

	const { id } = await params
	const draft = await getConnectionDraft(id)
	if (!draft) notFound()

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
			<div className="flex flex-col gap-2">
				<h1 className="text-ink text-2xl font-semibold tracking-tight">
					{draft.name}
				</h1>
				<p className="text-muted-foreground text-[13px] leading-relaxed">
					Saving reconnects and reinstalls the audit triggers. Removing a table
					from the list stops this dashboard reading it; the trigger and its
					recorded history stay in the database.
				</p>
			</div>

			{draft.sealed ? (
				<Callout tone="warning" title="Credentials cannot be decrypted">
					<code className="text-foreground font-mono text-xs">
						PG_CHRONICLE_JWT_SECRET
					</code>{' '}
					has changed since this connection was saved, so its stored connection
					string and S3 key can no longer be read. Re-enter them below to seal
					them under the current secret.
				</Callout>
			) : null}

			<ConnectionForm
				action={updateConnectionAction.bind(null, id)}
				existing={draft}
				submitLabel="Save changes"
			/>
		</div>
	)
}
