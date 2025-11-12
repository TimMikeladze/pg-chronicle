export interface LoggerOptions {
	correlationId: string
	write?: (message: string) => void
}

export interface Logger {
	debug(message: string, context?: Record<string, unknown>): void
	info(message: string, context?: Record<string, unknown>): void
	warn(message: string, context?: Record<string, unknown>): void
	error(message: string, context?: Record<string, unknown>): void
}

export function createLogger(options: LoggerOptions): Logger {
	const write = options.write || ((msg: string) => console.log(msg))

	function log(
		level: string,
		message: string,
		context?: Record<string, unknown>,
	) {
		const entry = {
			timestamp: new Date().toISOString(),
			level,
			correlation_id: options.correlationId,
			message,
			...context,
		}
		write(JSON.stringify(entry))
	}

	return {
		debug: (message, context) => log('debug', message, context),
		info: (message, context) => log('info', message, context),
		warn: (message, context) => log('warn', message, context),
		error: (message, context) => log('error', message, context),
	}
}
