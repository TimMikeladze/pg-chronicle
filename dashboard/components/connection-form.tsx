'use client'

import { DatabaseIcon, Loader2Icon } from 'lucide-react'
import Link from 'next/link'
import { useActionState, useId, useState } from 'react'

import { Panel, Section } from '@/components/section'
import { Callout } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
	type ConnectionFormState,
	EMPTY_FORM_STATE,
} from '@/lib/connection-input'

/**
 * The whole configuration of one audited database, in one form.
 *
 * Every field here used to be an environment variable, which meant adding a
 * database was a deployment. The trade being made deliberately: the dashboard
 * now holds credentials, so the form is explicit about what is stored, what is
 * encrypted, and what leaving a field blank means.
 *
 * Every field is controlled rather than `defaultValue`. React resets an
 * uncontrolled form after a server action resolves, and this action fails for
 * an entirely ordinary reason — a mistyped password, a table that does not
 * exist — so an uncontrolled form would clear a long connection string exactly
 * when the operator is about to correct one character of it.
 */

export interface ConnectionFormValues {
	name: string
	tables: string[]
	/** Never the connection string itself — only what it points at. */
	target: string | null
	/** True when the stored credentials cannot be decrypted and must be re-entered. */
	sealed: boolean
	archiver: {
		bucket: string
		endpoint: string
		region: string
		accessKeyId: string
		retentionDays: number
		gracePeriodDays: number
		batchSize: number
	} | null
	/** True when a secret access key is already stored for this connection. */
	hasStoredSecretKey: boolean
}

function Field({
	label,
	hint,
	children,
	htmlFor,
}: {
	label: string
	hint?: React.ReactNode
	htmlFor: string
	children: React.ReactNode
}) {
	return (
		<div className="flex flex-col gap-1.5">
			<Label htmlFor={htmlFor}>{label}</Label>
			{children}
			{hint ? (
				<p className="text-muted-foreground text-[12px] leading-relaxed">
					{hint}
				</p>
			) : null}
		</div>
	)
}

export function ConnectionForm({
	action,
	existing,
	submitLabel,
}: {
	action: (
		state: ConnectionFormState,
		form: FormData,
	) => Promise<ConnectionFormState>
	/** Absent when creating. */
	existing?: ConnectionFormValues
	submitLabel: string
}) {
	const [state, formAction, pending] = useActionState(action, EMPTY_FORM_STATE)
	const ids = useId()
	const field = (name: string) => `${ids}-${name}`

	const [name, setName] = useState(existing?.name ?? '')
	const [databaseUrl, setDatabaseUrl] = useState('')
	const [tables, setTables] = useState(existing?.tables.join(', ') ?? '')

	const [archival, setArchival] = useState(Boolean(existing?.archiver))
	const [bucket, setBucket] = useState(existing?.archiver?.bucket ?? '')
	const [region, setRegion] = useState(existing?.archiver?.region ?? '')
	const [endpoint, setEndpoint] = useState(existing?.archiver?.endpoint ?? '')
	const [accessKeyId, setAccessKeyId] = useState(
		existing?.archiver?.accessKeyId ?? '',
	)
	const [secretAccessKey, setSecretAccessKey] = useState('')
	const [retentionDays, setRetentionDays] = useState(
		String(existing?.archiver?.retentionDays ?? 90),
	)
	const [gracePeriodDays, setGracePeriodDays] = useState(
		String(existing?.archiver?.gracePeriodDays ?? 7),
	)
	const [batchSize, setBatchSize] = useState(
		String(existing?.archiver?.batchSize ?? 10_000),
	)

	return (
		<form action={formAction} className="flex flex-col gap-8">
			{state.error ? (
				<Callout title="Could not save this connection">{state.error}</Callout>
			) : null}

			<Section
				title="Database"
				description="The dashboard connects with these credentials, installs the audit triggers on the tables you list, and refuses to read any table you do not."
			>
				<Panel className="flex flex-col gap-5 p-5">
					<Field label="Name" htmlFor={field('name')}>
						<Input
							id={field('name')}
							name="name"
							required
							maxLength={64}
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="Production"
							autoComplete="off"
						/>
					</Field>

					<Field
						label="Connection string"
						htmlFor={field('databaseUrl')}
						hint={
							!existing ? (
								'Stored encrypted in the registry database and never rendered back into the page.'
							) : existing.sealed ? (
								'The stored value cannot be decrypted with the current secret — enter it again.'
							) : (
								<>
									Stored encrypted and never shown again. Currently pointing at{' '}
									<span className="text-foreground font-mono">
										{existing.target ?? 'an unreadable value'}
									</span>
									. Leave blank to keep it.
								</>
							)
						}
					>
						<Input
							id={field('databaseUrl')}
							name="databaseUrl"
							type="password"
							required={!existing || existing.sealed}
							value={databaseUrl}
							onChange={(event) => setDatabaseUrl(event.target.value)}
							placeholder="postgres://user:password@host:5432/database"
							autoComplete="off"
							spellCheck={false}
						/>
					</Field>

					<Field
						label="Audited tables"
						htmlFor={field('tables')}
						hint="Comma- or space-separated. Saving installs the audit triggers on each one — rows written before that have no history."
					>
						<Textarea
							id={field('tables')}
							name="tables"
							required
							rows={2}
							value={tables}
							onChange={(event) => setTables(event.target.value)}
							placeholder="users, orders"
							spellCheck={false}
							className="font-mono text-xs"
						/>
					</Field>
				</Panel>
			</Section>

			<Section
				title="Archival"
				description="Old entries are written to S3 as Parquet, soft-deleted, then purged once past the grace period. Without it the audit log grows unbounded."
			>
				<Panel className="flex flex-col gap-5 p-5">
					<label className="flex items-center gap-2.5 text-[13px]">
						<input
							type="checkbox"
							name="archiverEnabled"
							checked={archival}
							onChange={(event) => setArchival(event.target.checked)}
							className="accent-foreground size-3.5"
						/>
						Archive this connection’s history to S3
					</label>

					{archival ? (
						<div className="flex flex-col gap-5 border-t pt-5">
							<Field label="Bucket" htmlFor={field('s3Bucket')}>
								<Input
									id={field('s3Bucket')}
									name="s3Bucket"
									required
									value={bucket}
									onChange={(event) => setBucket(event.target.value)}
									placeholder="my-audit-archive"
									autoComplete="off"
									spellCheck={false}
								/>
							</Field>

							<div className="grid gap-5 sm:grid-cols-2">
								<Field
									label="Region"
									htmlFor={field('s3Region')}
									hint="Default: us-east-1"
								>
									<Input
										id={field('s3Region')}
										name="s3Region"
										value={region}
										onChange={(event) => setRegion(event.target.value)}
										placeholder="us-east-1"
										autoComplete="off"
										spellCheck={false}
									/>
								</Field>
								<Field
									label="Endpoint"
									htmlFor={field('s3Endpoint')}
									hint="Only for S3-compatible storage (MinIO, R2, Tigris)."
								>
									<Input
										id={field('s3Endpoint')}
										name="s3Endpoint"
										value={endpoint}
										onChange={(event) => setEndpoint(event.target.value)}
										placeholder="https://s3.example.com"
										autoComplete="off"
										spellCheck={false}
									/>
								</Field>
							</div>

							<div className="grid gap-5 sm:grid-cols-2">
								<Field label="Access key id" htmlFor={field('s3AccessKeyId')}>
									<Input
										id={field('s3AccessKeyId')}
										name="s3AccessKeyId"
										value={accessKeyId}
										onChange={(event) => setAccessKeyId(event.target.value)}
										autoComplete="off"
										spellCheck={false}
									/>
								</Field>
								<Field
									label="Secret access key"
									htmlFor={field('s3SecretAccessKey')}
									hint={
										existing?.hasStoredSecretKey && existing.sealed
											? 'The stored key cannot be decrypted with the current secret — enter it again.'
											: existing?.hasStoredSecretKey
												? 'Stored encrypted. Leave blank to keep the current one.'
												: 'Stored encrypted. Leave both key fields blank to use the instance’s ambient AWS credentials.'
									}
								>
									<Input
										id={field('s3SecretAccessKey')}
										name="s3SecretAccessKey"
										type="password"
										value={secretAccessKey}
										onChange={(event) => setSecretAccessKey(event.target.value)}
										autoComplete="off"
										spellCheck={false}
									/>
								</Field>
							</div>

							<div className="grid gap-5 sm:grid-cols-3">
								<Field
									label="Retention (days)"
									htmlFor={field('retentionDays')}
									hint="Entries older than this are archived."
								>
									<Input
										id={field('retentionDays')}
										name="retentionDays"
										type="number"
										min={1}
										value={retentionDays}
										onChange={(event) => setRetentionDays(event.target.value)}
									/>
								</Field>
								<Field
									label="Grace period (days)"
									htmlFor={field('gracePeriodDays')}
									hint="0 purges as soon as the S3 write is confirmed."
								>
									<Input
										id={field('gracePeriodDays')}
										name="gracePeriodDays"
										type="number"
										min={0}
										value={gracePeriodDays}
										onChange={(event) => setGracePeriodDays(event.target.value)}
									/>
								</Field>
								<Field
									label="Batch size"
									htmlFor={field('batchSize')}
									hint="Rows per archival batch."
								>
									<Input
										id={field('batchSize')}
										name="batchSize"
										type="number"
										min={1}
										value={batchSize}
										onChange={(event) => setBatchSize(event.target.value)}
									/>
								</Field>
							</div>
						</div>
					) : null}
				</Panel>
			</Section>

			<div className="flex flex-wrap items-center gap-3">
				<Button type="submit" disabled={pending}>
					{pending ? (
						<Loader2Icon className="animate-spin" />
					) : (
						<DatabaseIcon />
					)}
					{pending ? 'Connecting…' : submitLabel}
				</Button>
				<Button asChild variant="ghost">
					<Link href="/connections">Cancel</Link>
				</Button>
				<p className="text-muted-foreground text-[12px]">
					Saving connects to the database and installs the audit triggers.
				</p>
			</div>
		</form>
	)
}
