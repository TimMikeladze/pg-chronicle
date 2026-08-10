'use client'

import { TriangleAlertIcon } from 'lucide-react'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { loginAction } from '@/app/login/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

function SubmitButton() {
	const { pending } = useFormStatus()
	return (
		<Button type="submit" disabled={pending}>
			{pending ? 'Signing in…' : 'Sign in'}
		</Button>
	)
}

export function LoginForm({ next }: { next?: string }) {
	const [state, formAction] = useActionState(loginAction, {})

	return (
		<form action={formAction} className="flex flex-col gap-4">
			{/* Round-trips the requested destination; the action re-validates it as
			    a relative path before redirecting. */}
			<input type="hidden" name="next" value={next ?? '/'} />

			<div className="flex flex-col gap-2">
				<Label htmlFor="password">Dashboard password</Label>
				<Input
					id="password"
					name="password"
					type="password"
					autoComplete="current-password"
					required
				/>
			</div>

			{state.error ? (
				<p
					className="flex items-center gap-2 text-[13px]"
					style={{ color: 'var(--status-error)' }}
					role="alert"
				>
					<TriangleAlertIcon className="size-4 shrink-0" />
					{state.error}
				</p>
			) : null}

			<SubmitButton />
		</form>
	)
}
