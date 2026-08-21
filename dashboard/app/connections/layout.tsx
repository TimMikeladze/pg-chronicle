import { Shell } from '@/components/shell'

export default function ConnectionsLayout({
	children,
}: {
	children: React.ReactNode
}) {
	// No connection scope: these pages are about the set of connections, not any
	// one of them, so the bar shows the switcher without a table selector.
	return <Shell>{children}</Shell>
}
