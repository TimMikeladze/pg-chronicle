/**
 * The sign-in page renders without the application chrome — the bar names the
 * connections this deployment manages, which is not information for someone who
 * has not signed in yet. It still needs the page gutter the shell would have
 * provided.
 */
export default function LoginLayout({
	children,
}: {
	children: React.ReactNode
}) {
	return (
		<main className="mx-auto w-full max-w-[1400px] px-6 py-8">{children}</main>
	)
}
