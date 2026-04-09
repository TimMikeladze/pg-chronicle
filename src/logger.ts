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
 * Default logger that writes to console with a [pg-history] tag.
 * Suitable for CLIs, small services, or local development.
 */
// Default logger intentionally uses console.* — all other call sites route
// through this interface so library code never touches console directly.
export const consoleLogger: Logger = {
	debug(message, context) {
		console.debug(format('debug', message, context))
	},
	info(message, context) {
		console.log(format('info', message, context))
	},
	warn(message, context) {
		console.warn(format('warn', message, context))
	},
	error(message, context) {
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
	const prefix = `[pg-history] [${level}] ${message}`
	if (!context || Object.keys(context).length === 0) return prefix
	try {
		return `${prefix} ${JSON.stringify(context, replacer)}`
	} catch {
		return prefix
	}
}

function replacer(_key: string, value: unknown): unknown {
	if (value instanceof Error) {
		return { name: value.name, message: value.message, stack: value.stack }
	}
	return value
}
