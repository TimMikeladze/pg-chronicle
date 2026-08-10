/**
 * Minimal assertion helpers so each example doubles as a smoke test.
 *
 * Examples print what they demonstrate *and* verify it, so a regression
 * fails the example instead of quietly printing wrong output.
 * Not part of the published package — examples only.
 */

export function assert(condition: unknown, message: string): asserts condition {
	if (!condition) {
		throw new Error(`Assertion failed: ${message}`)
	}
}

export function assertEqual<T>(actual: T, expected: T, message: string): void {
	if (!Object.is(actual, expected)) {
		throw new Error(
			`Assertion failed: ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
		)
	}
}

/**
 * Asserts that `fn` throws, and that the thrown value passes `check`.
 * Returns the caught error so callers can log it.
 */
export async function assertThrows(
	fn: () => Promise<unknown>,
	check: (error: unknown) => boolean,
	message: string,
): Promise<unknown> {
	try {
		await fn()
	} catch (error) {
		assert(check(error), `${message} — wrong error: ${String(error)}`)
		return error
	}
	throw new Error(`Assertion failed: ${message} — nothing was thrown`)
}

/**
 * Runs an example's main function, exiting non-zero on failure so CI and
 * `test/examples.test.ts` can tell a broken example from a working one.
 */
export function run(main: () => Promise<void>): void {
	main().catch((error) => {
		console.error(error)
		process.exit(1)
	})
}
