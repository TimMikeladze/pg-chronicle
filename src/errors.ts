export class PgChronicleError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PgChronicleError'
	}
}

export class TableNotConfiguredError extends PgChronicleError {
	constructor(tableName: string) {
		super(`Table "${tableName}" is not configured for history tracking`)
		this.name = 'TableNotConfiguredError'
	}
}

export class SetupRequiredError extends PgChronicleError {
	constructor() {
		super(
			'setup() must be called before querying. Call await history.setup() first.',
		)
		this.name = 'SetupRequiredError'
	}
}

export class AuditEntryNotFoundError extends PgChronicleError {
	constructor(auditEntryId: string, tableName: string, recordId: string) {
		super(`Audit entry ${auditEntryId} not found for ${tableName}:${recordId}`)
		this.name = 'AuditEntryNotFoundError'
	}
}

export class ValidationError extends PgChronicleError {
	constructor(message: string) {
		super(message)
		this.name = 'ValidationError'
	}
}

export class RevertError extends PgChronicleError {
	constructor(message: string) {
		super(message)
		this.name = 'RevertError'
	}
}

/**
 * Thrown by {@link PgChronicle.search} when the number of in-flight searches
 * exceeds `maxConcurrentSearches`. API handlers translate this into 429.
 */
export class SearchConcurrencyLimitError extends PgChronicleError {
	constructor() {
		super('Too many concurrent search requests. Try again shortly.')
		this.name = 'SearchConcurrencyLimitError'
	}
}

/**
 * Thrown when a request fails the server's authorization hook. API handlers
 * translate this into 403.
 */
export class AuthorizationError extends PgChronicleError {
	constructor(message = 'Not authorized for this resource') {
		super(message)
		this.name = 'AuthorizationError'
	}
}
