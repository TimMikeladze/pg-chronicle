/**
 * Lightweight logger interface with structured context.
 *
 * PgHistory, PgHistoryArchiver, Orchestrator, and the server accept an
 * injectable Logger so consumers can plug in pino/winston/bunyan/etc.
 *
 * The default logger is console-based but can be silenced by passing
 * {@link silentLogger}. This keeps the library test-friendly and avoids
 * using console.* directly in production code paths.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export type LogContext = Record<string, unknown>

export interface Logger {
	debug(message: string, context?: LogContext): void
	info(message: string, context?: LogContext): void
	warn(message: string, context?: LogContext): void
	error(message: string, context?: LogContext): void
}

/**
 * Default logger that writes to console with a [pghistory] tag.
 * Suitable for CLIs, small services, or local development.
 */
// Default logger intentionally uses console.* — all other call sites route
// through this interface so library code never touches console directly.
// Honors PGHISTORY_SILENT_LOGS=1 to drop output (used by test suite).
const isSilent = (): boolean => process.env.PGHISTORY_SILENT_LOGS === '1'

export const consoleLogger: Logger = {
	debug(message, context) {
		if (isSilent()) return
		console.debug(format('debug', message, context))
	},
	info(message, context) {
		if (isSilent()) return
		console.log(format('info', message, context))
	},
	warn(message, context) {
		if (isSilent()) return
		console.warn(format('warn', message, context))
	},
	error(message, context) {
		if (isSilent()) return
		console.error(format('error', message, context))
	},
}

/**
 * Silent logger that drops all messages. Useful in tests.
 */
export const silentLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
}

function format(
	level: LogLevel,
	message: string,
	context?: LogContext,
): string {
	const prefix = `[pghistory] [${level}] ${message}`
	if (!context || Object.keys(context).length === 0) return prefix
	try {
		// Track seen objects so circular references degrade gracefully instead
		// of throwing inside JSON.stringify and losing the whole log line.
		const seen = new WeakSet<object>()
		const reviveSafely = (_key: string, value: unknown): unknown => {
			if (value instanceof Error) {
				return { name: value.name, message: value.message, stack: value.stack }
			}
			if (typeof value === 'bigint') return value.toString()
			if (value && typeof value === 'object') {
				// Buffer summary instead of {type:'Buffer', data:[...]} which floods output
				const maybeBuf = value as { type?: string; length?: number }
				if (maybeBuf.type === 'Buffer' && typeof maybeBuf.length === 'number') {
					return `<Buffer length=${maybeBuf.length}>`
				}
				if (seen.has(value as object)) return '[Circular]'
				seen.add(value as object)
			}
			return value
		}
		return `${prefix} ${JSON.stringify(context, reviveSafely)}`
	} catch {
		return prefix
	}
}

// Track pools we've already attached handlers to. Without this, attaching
// twice (e.g. constructor + ensurePool retry) duplicates listeners and
// trips Node's MaxListenersExceededWarning at 10.
const handledPools = new WeakSet<object>()

/**
 * Attach an idle-client error listener to a pg Pool. Idempotent — attaching
 * twice to the same pool is a no-op. Without a handler, idle-client backend
 * disconnects rethrow as uncaughtException and kill Node.
 */
export function attachPoolErrorHandler(
	pool: { on(event: 'error', cb: (err: unknown) => void): void },
	logger: Logger,
	label: string,
): void {
	if (handledPools.has(pool as unknown as object)) return
	handledPools.add(pool as unknown as object)
	pool.on('error', (err) => {
		logger.error(`${label} pool idle client error`, {
			err: err instanceof Error ? err.message : String(err),
		})
	})
}

/**
 * Close a pg Pool with a hard timeout. `pool.end()` waits indefinitely for
 * checked-out clients to release — under SIGTERM that means shutdown hangs.
 * Race against a timer and proceed regardless; the OS reclaims sockets on exit.
 */
export async function endPoolWithTimeout(
	pool: { end(): Promise<void> },
	timeoutMs: number,
	logger: Logger,
	label: string,
): Promise<void> {
	await Promise.race([
		pool.end(),
		new Promise<void>((resolve) => {
			const t = setTimeout(() => {
				logger.warn(`${label} pool.end() timed out; forcing close`, {
					timeoutMs,
				})
				resolve()
			}, timeoutMs)
			if (typeof t === 'object' && t && 'unref' in t) {
				;(t as unknown as { unref: () => void }).unref()
			}
		}),
	])
}
