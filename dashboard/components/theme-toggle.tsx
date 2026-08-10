'use client'

import { MoonIcon, SunIcon } from 'lucide-react'
import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'

export function ThemeToggle() {
	const { resolvedTheme, setTheme } = useTheme()
	const [mounted, setMounted] = useState(false)

	// The server cannot know the resolved theme, so rendering the real icon
	// before hydration guarantees a mismatch. Hold a same-sized placeholder.
	useEffect(() => setMounted(true), [])

	if (!mounted) {
		return <Button variant="ghost" size="icon" aria-hidden disabled />
	}

	const next = resolvedTheme === 'dark' ? 'light' : 'dark'
	return (
		<Button
			variant="ghost"
			size="icon"
			onClick={() => setTheme(next)}
			aria-label={`Switch to ${next} theme`}
		>
			{resolvedTheme === 'dark' ? <SunIcon /> : <MoonIcon />}
		</Button>
	)
}
