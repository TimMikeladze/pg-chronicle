export class PgHistoryError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'PgHistoryError'
	}
}

export class TableNotConfiguredError extends PgHistoryError {
	constructor(tableName: string) {
		super(`Table "${tableName}" is not configured for history tracking`)
		this.name = 'TableNotConfiguredError'
	}
}

export class SetupRequiredError extends PgHistoryError {
	constructor() {
		super(
			'setup() must be called before querying. Call await history.setup() first.',
		)
		this.name = 'SetupRequiredError'
	}
}

export class AuditEntryNotFoundError extends PgHistoryError {
	constructor(auditEntryId: string, tableName: string, recordId: string) {
		super(`Audit entry ${auditEntryId} not found for ${tableName}:${recordId}`)
		this.name = 'AuditEntryNotFoundError'
	}
}

export class ValidationError extends PgHistoryError {
	constructor(message: string) {
		super(message)
		this.name = 'ValidationError'
	}
}

export class RevertError extends PgHistoryError {
	constructor(message: string) {
		super(message)
		this.name = 'RevertError'
	}
}
