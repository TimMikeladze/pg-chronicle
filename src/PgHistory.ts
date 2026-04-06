import type { Pool } from 'pg'
import {
	AuditEntryNotFoundError,
	SetupRequiredError,
	TableNotConfiguredError,
	ValidationError,
} from './errors'
import type {
	AuditEntry,
	GetHistoryOptions,
	PaginatedResult,
	PgHistoryConfig,
	SearchOptions,
} from './types'

export class PgHistory {
	private pool!: Pool
	private tables: string[]
	private ownConnection: boolean
	private schema: string = 'public'
	private primaryKeyCache: Map<string, string[]> = new Map()
	private pendingConnection: string | undefined
	private poolPromise: Promise<void> | null = null
	private setupComplete: boolean = false

	constructor(config: PgHistoryConfig) {
		this.tables = config.tables

		// Validate all table names before storing them (C1, I2)
		for (const tableName of this.tables) {
			this.validateTableName(tableName)
		}

		if (config.pool) {
			this.pool = config.pool
			this.ownConnection = false
		} else if (config.connection) {
			this.pendingConnection = config.connection
			this.ownConnection = true
		} else {
			throw new Error('PgHistory: No connection configuration provided')
		}
	}

	private async ensurePool(): Promise<void> {
		if (this.pool) return
		if (!this.poolPromise) {
			this.poolPromise = (async () => {
				if (!this.pendingConnection) return
				const pg = await import('pg')
				this.pool = new pg.default.Pool({
					connectionString: this.pendingConnection,
				})
				this.pendingConnection = undefined
			})()
		}
		await this.poolPromise
	}

	/**
	 * Validates table names to prevent SQL injection.
	 * PostgreSQL identifiers must start with a letter or underscore,
	 * and can contain only alphanumeric characters and underscores.
	 * Maximum length is 63 characters.
	 */
	private validateTableName(name: string): void {
		if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) {
			throw new Error(
				`Invalid table name: "${name}". Table names must start with a letter or underscore and contain only alphanumeric characters and underscores.`,
			)
		}
	}

	/**
	 * Validates column names to prevent SQL injection.
	 * Uses the same rules as table names - must start with letter/underscore,
	 * contain only alphanumeric and underscores, max 63 chars.
	 */
	private validateColumnName(name: string): void {
		if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) {
			throw new Error(
				`Invalid column name: "${name}". Column names must start with a letter or underscore and contain only alphanumeric characters and underscores.`,
			)
		}
	}

	/**
	 * Validates an array of column names.
	 */
	private validateColumnNames(names: string[]): void {
		for (const name of names) {
			this.validateColumnName(name)
		}
	}

	/**
	 * Validates user-provided string inputs to prevent DOS attacks
	 * and ensure reasonable string lengths.
	 */
	private validateStringInput(
		value: string,
		fieldName: string,
		maxLength: number = 1000,
	): void {
		if (typeof value !== 'string') {
			throw new Error(`${fieldName} must be a string`)
		}

		if (value.length === 0) {
			throw new Error(`${fieldName} cannot be empty`)
		}

		if (value.length > maxLength) {
			throw new Error(
				`${fieldName} exceeds maximum length of ${maxLength} characters`,
			)
		}

		// Check for null bytes which can cause issues
		if (value.includes('\0')) {
			throw new Error(`${fieldName} cannot contain null bytes`)
		}
	}

	/**
	 * Validates pagination limit to prevent memory exhaustion attacks.
	 * Caps all limits at a maximum of 1000 records per request.
	 */
	private validateLimit(
		limit: number | undefined,
		defaultLimit: number,
	): number {
		const MAX_LIMIT = 1000 // Absolute maximum to prevent memory exhaustion

		if (limit === undefined) {
			return defaultLimit
		}

		if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
			throw new Error('Limit must be a positive integer')
		}

		// Cap at maximum to prevent memory exhaustion
		return Math.min(limit, MAX_LIMIT)
	}

	private buildPkWhereClause(
		pkColumns: string[],
		data: Record<string, unknown>,
		paramOffset: number,
	): { whereClause: string; values: unknown[] } {
		const values: unknown[] = []
		const clauses = pkColumns.map((col) => {
			const value = data[col]
			if (value === undefined) {
				throw new Error(`Primary key column "${col}" not found in audit data`)
			}
			values.push(value)
			return `"${col}" = $${paramOffset + values.length}`
		})
		return { whereClause: clauses.join(' AND '), values }
	}

	/**
	 * Retrieves the primary key column(s) for a given table by querying PostgreSQL system catalogs.
	 * For composite primary keys, returns all columns in the order they're defined.
	 * If no primary key exists, returns an empty array.
	 *
	 * @param tableName - The name of the table to query
	 * @returns Array of primary key column names, empty if no primary key exists
	 */
	private async getPrimaryKeyColumns(tableName: string): Promise<string[]> {
		// Check cache first
		const cached = this.primaryKeyCache.get(tableName)
		if (cached !== undefined) {
			return cached
		}

		// Query PostgreSQL system catalogs to find primary key columns
		const result = await this.pool.query(
			`SELECT a.attname as column_name
			FROM pg_index i
			JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
			WHERE i.indrelid = $1::regclass
			AND i.indisprimary
			ORDER BY array_position(i.indkey, a.attnum)`,
			[tableName],
		)

		const columns = result.rows.map(
			(row: { column_name: string }) => row.column_name,
		)

		// Validate all column names to prevent SQL injection
		// This protects against malicious column names in the database
		this.validateColumnNames(columns)

		this.primaryKeyCache.set(tableName, columns)
		return columns
	}

	/**
	 * Sets up audit logging infrastructure for the configured tables.
	 *
	 * IMPORTANT - Transaction Safety:
	 * - Audit triggers execute within the same transaction as the DML operation
	 * - If audit log insertion fails, the entire transaction (including the original operation) will be rolled back
	 * - This is by design to ensure audit integrity - no operation should succeed without being audited
	 * - For high-volume operations or performance-critical paths, consider:
	 *   - Batch processing with appropriate transaction boundaries
	 *   - Implementing asynchronous audit logging patterns
	 *   - Using separate audit tables with different durability guarantees
	 *
	 * Note: This method is NOT wrapped in a transaction because:
	 * - DDL statements (CREATE TABLE, CREATE TRIGGER, etc.) auto-commit in PostgreSQL
	 * - Each operation is idempotent (uses IF NOT EXISTS/IF EXISTS checks)
	 * - Partial setup can be resumed by calling setup() again
	 * - Use teardown() to clean up if needed
	 *
	 * @throws Error if setup fails for any table
	 */
	async setup(): Promise<void> {
		await this.ensurePool()

		if (this.tables.length === 0) {
			throw new Error('PgHistory: No tables configured for history tracking')
		}

		try {
			await this.setupInternal()
			this.setupComplete = true
		} catch (error) {
			// Add context to error
			const errorMessage =
				error instanceof Error ? error.message : String(error)
			throw new Error(
				`PgHistory setup failed: ${errorMessage}. You may need to call teardown() to clean up partial state.`,
			)
		}
	}

	/**
	 * Internal setup implementation
	 */
	private async setupInternal(): Promise<void> {
		// Detect current schema (C2)
		const schemaResult = await this.pool.query(
			'SELECT current_schema() as schema',
		)
		this.schema = schemaResult.rows[0]?.schema || 'public'

		// Create partitioned audit_log table
		await this.pool.query(`
			CREATE TABLE IF NOT EXISTS ${this.auditTable} (
				id BIGSERIAL,
				table_name TEXT NOT NULL,
				record_id TEXT NOT NULL,
				operation TEXT NOT NULL,
				changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				old_data JSONB,
				new_data JSONB,
				PRIMARY KEY (id, table_name)
			) PARTITION BY LIST (table_name)
		`)

		// Create partitions for each table
		for (const tableName of this.tables) {
			const partitionName = `audit_log_${tableName}`

			// Check if partition exists
			const exists = await this.pool.query(
				'SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = $2',
				[this.schema, partitionName],
			)

			if (exists.rows.length === 0) {
				try {
					// Use format() with %I/%L to safely interpolate identifiers/literals
					// Explicit ::text casts required so PG can infer parameter types
					const ddlResult = await this.pool.query(
						`SELECT format(
							'CREATE TABLE %I.%I PARTITION OF %I.%I FOR VALUES IN (%L)',
							$1::text, $2::text, $1::text, $3::text, $4::text
						) AS ddl`,
						[this.schema, partitionName, 'audit_log', tableName],
					)
					await this.pool.query(ddlResult.rows[0].ddl)
				} catch (error) {
					// I4: Add error context
					throw new Error(
						`Failed to create partition for table "${tableName}": ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			} else {
				console.warn(
					`[pg-history] Partition ${partitionName} already exists, skipping`,
				)
			}
		}

		// Create indexes (IF NOT EXISTS will skip if they exist)
		await this.pool.query(`
			CREATE INDEX IF NOT EXISTS idx_audit_old_data_gin
			ON ${this.auditTable} USING GIN (old_data jsonb_path_ops)
		`)

		await this.pool.query(`
			CREATE INDEX IF NOT EXISTS idx_audit_new_data_gin
			ON ${this.auditTable} USING GIN (new_data jsonb_path_ops)
		`)

		await this.pool.query(`
			CREATE INDEX IF NOT EXISTS idx_audit_changed_at
			ON ${this.auditTable} (changed_at DESC)
		`)

		await this.pool.query(`
			CREATE INDEX IF NOT EXISTS idx_audit_record_id
			ON ${this.auditTable} (table_name, record_id, changed_at DESC)
		`)

		// Create triggers for each table with table-specific trigger functions
		for (const tableName of this.tables) {
			const triggerName = `audit_trigger_${tableName}`
			const funcName = `audit_trigger_func_${tableName}`

			// Check if the target table exists
			const tableExists = await this.pool.query(
				'SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = $2',
				[this.schema, tableName],
			)

			if (tableExists.rows.length === 0) {
				console.warn(
					`[pg-history] Table ${tableName} does not exist, skipping trigger creation`,
				)
				continue
			}

			// Get primary key columns for this table
			const pkColumns = await this.getPrimaryKeyColumns(tableName)

			// Create table-specific trigger function (idempotent)
			// Build the function body based on primary key configuration.
			// Defense-in-depth: re-validate all identifiers immediately before
			// interpolation into PL/pgSQL, even though they were validated earlier.
			// The regex ensures only [a-zA-Z0-9_] chars, making SQL injection
			// through double-quoted identifiers impossible.
			this.validateTableName(tableName)
			this.validateColumnName(funcName.replace(/^audit_trigger_func_/, ''))
			for (const col of pkColumns) {
				this.validateColumnName(col)
			}
			let functionBody: string

			if (pkColumns.length === 0) {
				// No primary key: use hash of all column values
				functionBody = `
				CREATE OR REPLACE FUNCTION "${funcName}"()
				RETURNS TRIGGER AS $$
				BEGIN
					IF (TG_OP = 'DELETE') THEN
						INSERT INTO ${this.auditTable} (table_name, record_id, operation, old_data)
						VALUES (TG_TABLE_NAME, md5(row_to_json(OLD)::text), TG_OP, to_jsonb(OLD));
						RETURN OLD;
					ELSIF (TG_OP = 'UPDATE') THEN
						INSERT INTO ${this.auditTable} (table_name, record_id, operation, old_data, new_data)
						VALUES (TG_TABLE_NAME, md5(row_to_json(NEW)::text), TG_OP, to_jsonb(OLD), to_jsonb(NEW));
						RETURN NEW;
					ELSIF (TG_OP = 'INSERT') THEN
						INSERT INTO ${this.auditTable} (table_name, record_id, operation, new_data)
						VALUES (TG_TABLE_NAME, md5(row_to_json(NEW)::text), TG_OP, to_jsonb(NEW));
						RETURN NEW;
					END IF;
				END;
				$$ LANGUAGE plpgsql;
				`
			} else if (pkColumns.length === 1) {
				// Single primary key
				const pkCol = pkColumns[0]
				functionBody = `
				CREATE OR REPLACE FUNCTION "${funcName}"()
				RETURNS TRIGGER AS $$
				BEGIN
					IF (TG_OP = 'DELETE') THEN
						INSERT INTO ${this.auditTable} (table_name, record_id, operation, old_data)
						VALUES (TG_TABLE_NAME, OLD."${pkCol}"::text, TG_OP, to_jsonb(OLD));
						RETURN OLD;
					ELSIF (TG_OP = 'UPDATE') THEN
						INSERT INTO ${this.auditTable} (table_name, record_id, operation, old_data, new_data)
						VALUES (TG_TABLE_NAME, NEW."${pkCol}"::text, TG_OP, to_jsonb(OLD), to_jsonb(NEW));
						RETURN NEW;
					ELSIF (TG_OP = 'INSERT') THEN
						INSERT INTO ${this.auditTable} (table_name, record_id, operation, new_data)
						VALUES (TG_TABLE_NAME, NEW."${pkCol}"::text, TG_OP, to_jsonb(NEW));
						RETURN NEW;
					END IF;
				END;
				$$ LANGUAGE plpgsql;
				`
			} else {
				// Composite primary key: concatenate with '|' delimiter
				const pkExpressionsNew = pkColumns
					.map((col) => `COALESCE(NEW."${col}"::text, '')`)
					.join(" || '|' || ")
				const pkExpressionsOld = pkColumns
					.map((col) => `COALESCE(OLD."${col}"::text, '')`)
					.join(" || '|' || ")
				functionBody = `
				CREATE OR REPLACE FUNCTION "${funcName}"()
				RETURNS TRIGGER AS $$
				BEGIN
					IF (TG_OP = 'DELETE') THEN
						INSERT INTO ${this.auditTable} (table_name, record_id, operation, old_data)
						VALUES (TG_TABLE_NAME, ${pkExpressionsOld}, TG_OP, to_jsonb(OLD));
						RETURN OLD;
					ELSIF (TG_OP = 'UPDATE') THEN
						INSERT INTO ${this.auditTable} (table_name, record_id, operation, old_data, new_data)
						VALUES (TG_TABLE_NAME, ${pkExpressionsNew}, TG_OP, to_jsonb(OLD), to_jsonb(NEW));
						RETURN NEW;
					ELSIF (TG_OP = 'INSERT') THEN
						INSERT INTO ${this.auditTable} (table_name, record_id, operation, new_data)
						VALUES (TG_TABLE_NAME, ${pkExpressionsNew}, TG_OP, to_jsonb(NEW));
						RETURN NEW;
					END IF;
				END;
				$$ LANGUAGE plpgsql;
				`
			}

			await this.pool.query(functionBody)

			// Check if trigger exists
			const triggerExists = await this.pool.query(
				'SELECT 1 FROM pg_trigger WHERE tgname = $1',
				[triggerName],
			)

			if (triggerExists.rows.length === 0) {
				try {
					// Use format() for trigger DDL to safely interpolate identifiers
					const triggerDdl = await this.pool.query(
						`SELECT format(
							'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION %I()',
							$1::text, $2::text, $3::text
						) AS ddl`,
						[triggerName, tableName, funcName],
					)
					await this.pool.query(triggerDdl.rows[0].ddl)
				} catch (error) {
					throw new Error(
						`Failed to create trigger for table "${tableName}": ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			} else {
				console.warn(
					`[pg-history] Trigger ${triggerName} already exists, skipping`,
				)
			}
		}
	}

	/** Returns schema-qualified audit_log table name */
	private get auditTable(): string {
		return `"${this.schema}"."audit_log"`
	}

	private ensureSetup(): void {
		if (!this.setupComplete) {
			throw new SetupRequiredError()
		}
	}

	async getHistory(
		tableName: string,
		recordId: string,
		options: GetHistoryOptions = {},
	): Promise<PaginatedResult<AuditEntry>> {
		this.ensureSetup()

		if (!this.tables.includes(tableName)) {
			throw new TableNotConfiguredError(tableName)
		}

		// Validate recordId to prevent DOS attacks
		this.validateStringInput(recordId, 'recordId', 500)

		// Validate and cap limit to prevent memory exhaustion (max 1000)
		const limit = this.validateLimit(options.limit, 50)
		const order = options.order || 'desc'

		// Validate cursor if provided — must be a numeric ID
		if (options.cursor) {
			this.validateStringInput(options.cursor, 'cursor', 100)
			if (!/^\d+$/.test(options.cursor)) {
				throw new ValidationError('cursor must be a numeric ID')
			}
		}

		let queryResult: { rows: unknown[] }
		if (options.cursor) {
			// Cursor-based pagination
			if (order === 'desc') {
				queryResult = await this.pool.query(
					`SELECT * FROM ${this.auditTable}
					WHERE table_name = $1
					AND record_id = $2
					AND id < $3
					ORDER BY id DESC
					LIMIT $4`,
					[tableName, recordId, options.cursor, limit + 1],
				)
			} else {
				queryResult = await this.pool.query(
					`SELECT * FROM ${this.auditTable}
					WHERE table_name = $1
					AND record_id = $2
					AND id > $3
					ORDER BY id ASC
					LIMIT $4`,
					[tableName, recordId, options.cursor, limit + 1],
				)
			}
		} else {
			// First page
			if (order === 'desc') {
				queryResult = await this.pool.query(
					`SELECT * FROM ${this.auditTable}
					WHERE table_name = $1
					AND record_id = $2
					ORDER BY id DESC
					LIMIT $3`,
					[tableName, recordId, limit + 1],
				)
			} else {
				queryResult = await this.pool.query(
					`SELECT * FROM ${this.auditTable}
					WHERE table_name = $1
					AND record_id = $2
					ORDER BY id ASC
					LIMIT $3`,
					[tableName, recordId, limit + 1],
				)
			}
		}

		const rows = queryResult.rows as Array<{
			id: number
			table_name: string
			record_id: string
			operation: string
			changed_at: string
			old_data: Record<string, unknown> | null
			new_data: Record<string, unknown> | null
		}>
		const hasMore = rows.length > limit
		const data = rows.slice(0, limit)

		const entries: AuditEntry[] = data.map((row) => ({
			id: row.id.toString(),
			tableName: row.table_name,
			recordId: row.record_id,
			operation: row.operation as 'INSERT' | 'UPDATE' | 'DELETE',
			changedAt: new Date(row.changed_at),
			oldData: row.old_data,
			newData: row.new_data,
		}))

		const lastItem = data[data.length - 1]
		const nextCursor = hasMore && lastItem ? lastItem.id.toString() : null

		return {
			data: entries,
			nextCursor,
			hasMore,
		}
	}

	async search(options: SearchOptions): Promise<PaginatedResult<AuditEntry>> {
		this.ensureSetup()

		if (options.tables.length === 0) {
			throw new Error(
				'PgHistory: At least one table must be specified for search',
			)
		}

		const invalidTables = options.tables.filter((t) => !this.tables.includes(t))
		if (invalidTables.length > 0) {
			throw new TableNotConfiguredError(invalidTables.join(', '))
		}

		// Validate and cap limit to prevent memory exhaustion (max 1000)
		const limit = this.validateLimit(options.limit, 100)
		const tables = options.tables

		// Validate cursor if provided — must be a numeric ID
		if (options.cursor) {
			this.validateStringInput(options.cursor, 'cursor', 100)
			if (!/^\d+$/.test(options.cursor)) {
				throw new ValidationError('cursor must be a numeric ID')
			}
		}

		// Build WHERE conditions
		const conditions: string[] = []
		const params: unknown[] = []
		let paramIndex = 1
		let usesIlike = false // eslint-disable-line prefer-const

		// Table filter - pass JS array directly, pg driver handles conversion
		conditions.push(`table_name = ANY($${paramIndex}::text[])`)
		params.push(tables)
		paramIndex++

		// Search on JSONB data
		if (options.query) {
			this.validateStringInput(options.query, 'query', 500)

			const trimmed = options.query.trim()
			if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
				// JSON object query — use @> containment (uses GIN index)
				let parsed: unknown
				try {
					parsed = JSON.parse(trimmed)
				} catch {
					throw new Error(
						'PgHistory: query looks like JSON but failed to parse',
					)
				}
				const jsonStr = JSON.stringify(parsed)
				conditions.push(
					`(old_data @> $${paramIndex}::jsonb OR new_data @> $${paramIndex}::jsonb)`,
				)
				params.push(jsonStr)
				paramIndex++
			} else {
				// Plain text query — ILIKE fallback (unindexed, uses statement timeout)
				usesIlike = true
				const escapedQuery = options.query
					.replace(/\\/g, '\\\\')
					.replace(/%/g, '\\%')
					.replace(/_/g, '\\_')

				conditions.push(
					`(old_data::text ILIKE $${paramIndex} OR new_data::text ILIKE $${paramIndex})`,
				)
				params.push(`%${escapedQuery}%`)
				paramIndex++
			}
		}

		// Operation filter
		if (options.operation) {
			const validOperations = ['INSERT', 'UPDATE', 'DELETE'] as const
			if (!validOperations.includes(options.operation)) {
				throw new Error(
					`PgHistory: Invalid operation "${options.operation}". Must be one of: INSERT, UPDATE, DELETE`,
				)
			}
			conditions.push(`operation = $${paramIndex}`)
			params.push(options.operation)
			paramIndex++
		}

		// Date range filter
		if (options.dateFrom) {
			conditions.push(`changed_at >= $${paramIndex}`)
			params.push(options.dateFrom)
			paramIndex++
		}

		if (options.dateTo) {
			conditions.push(`changed_at <= $${paramIndex}`)
			params.push(options.dateTo)
			paramIndex++
		}

		// Cursor filter
		if (options.cursor) {
			conditions.push(`id < $${paramIndex}`)
			params.push(options.cursor)
			paramIndex++
		}

		const whereClause = conditions.join(' AND ')

		// Execute query
		const query = `
			SELECT * FROM ${this.auditTable}
			WHERE ${whereClause}
			ORDER BY id DESC
			LIMIT $${paramIndex}
		`
		params.push(limit + 1)

		// ILIKE queries are unindexed full scans — use a dedicated client
		// with a statement timeout to prevent runaway queries
		let queryResult: { rows: unknown[] }
		if (usesIlike) {
			const client = await this.pool.connect()
			try {
				await client.query('SET statement_timeout = 5000') // 5s max
				queryResult = await client.query(query, params)
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.includes('statement timeout')
				) {
					throw new Error(
						'PgHistory: Text search query timed out. Use JSON containment search (pass a JSON object as query) for better performance on large tables.',
					)
				}
				throw error
			} finally {
				await client.query('RESET statement_timeout').catch(() => {})
				client.release()
			}
		} else {
			queryResult = await this.pool.query(query, params)
		}

		const rows = queryResult.rows as Array<{
			id: number
			table_name: string
			record_id: string
			operation: string
			changed_at: string
			old_data: Record<string, unknown> | null
			new_data: Record<string, unknown> | null
		}>

		const hasMore = rows.length > limit
		const data = rows.slice(0, limit)

		const entries: AuditEntry[] = data.map((row) => ({
			id: row.id.toString(),
			tableName: row.table_name,
			recordId: row.record_id,
			operation: row.operation as 'INSERT' | 'UPDATE' | 'DELETE',
			changedAt: new Date(row.changed_at),
			oldData: row.old_data,
			newData: row.new_data,
		}))

		const lastItem = data[data.length - 1]
		const nextCursor = hasMore && lastItem ? lastItem.id.toString() : null

		return {
			data: entries,
			nextCursor,
			hasMore,
		}
	}

	async revert(
		tableName: string,
		recordId: string,
		auditEntryId: string,
	): Promise<void> {
		this.ensureSetup()

		if (!this.tables.includes(tableName)) {
			throw new TableNotConfiguredError(tableName)
		}

		// Wrap entire revert operation in a transaction for consistency
		// Get a client from the pool and use it for the transaction
		const client = await this.pool.connect()
		try {
			await client.query('BEGIN')

			// Get the audit entry
			const entryResult = await client.query(
				`SELECT * FROM ${this.auditTable}
				WHERE id = $1
				AND table_name = $2
				AND record_id = $3`,
				[auditEntryId, tableName, recordId],
			)
			const [entry] = entryResult.rows as Array<{
				id: number
				table_name: string
				record_id: string
				operation: string
				old_data: Record<string, unknown> | null
				new_data: Record<string, unknown> | null
			}>

			if (!entry) {
				throw new AuditEntryNotFoundError(auditEntryId, tableName, recordId)
			}

			// Get primary key columns
			const pkColumns = await this.getPrimaryKeyColumns(tableName)
			if (pkColumns.length === 0) {
				throw new Error(
					`Cannot revert table "${tableName}" - no primary key defined`,
				)
			}

			// Validate PK columns
			this.validateColumnNames(pkColumns)

			// Cross-check revert data columns against actual table columns
			// to prevent writing to unintended columns via crafted audit_log entries
			const revertData = entry.old_data || entry.new_data || {}
			const dataColumns = Object.keys(revertData)
			if (dataColumns.length > 0) {
				const colResult = await client.query(
					`SELECT column_name FROM information_schema.columns
					WHERE table_schema = $1 AND table_name = $2`,
					[this.schema, tableName],
				)
				const realColumns = new Set(
					colResult.rows.map((r: { column_name: string }) => r.column_name),
				)
				const unknownColumns = dataColumns.filter((c) => !realColumns.has(c))
				if (unknownColumns.length > 0) {
					throw new Error(
						`Revert data contains columns not in table "${tableName}": ${unknownColumns.join(', ')}`,
					)
				}
			}

			// Branch on operation type
			if (entry.operation === 'INSERT') {
				// Undo INSERT = DELETE the row
				const revertData = entry.new_data || {}
				const { whereClause, values } = this.buildPkWhereClause(
					pkColumns,
					revertData,
					0,
				)

				const deleteQuery = `
					DELETE FROM "${tableName}"
					WHERE ${whereClause}
					RETURNING true as success
				`
				const deleteResult = await client.query(deleteQuery, values)
				if (!deleteResult.rows || deleteResult.rows.length === 0) {
					throw new Error(
						`Failed to revert INSERT for record ${recordId} in table ${tableName} - row not found`,
					)
				}
			} else if (entry.operation === 'DELETE') {
				// Undo DELETE = re-INSERT the row
				const revertData = entry.old_data
				if (!revertData || Object.keys(revertData).length === 0) {
					throw new Error(
						`No old_data available to revert DELETE for entry ${auditEntryId}`,
					)
				}

				const allColumns = Object.keys(revertData)
				this.validateColumnNames(allColumns)

				const columnList = allColumns.map((col) => `"${col}"`).join(', ')
				const placeholders = allColumns
					.map((_, idx) => `$${idx + 1}`)
					.join(', ')
				const values = allColumns.map((col) => revertData[col])

				const insertQuery = `
					INSERT INTO "${tableName}" (${columnList})
					VALUES (${placeholders})
					RETURNING true as success
				`
				const insertResult = await client.query(insertQuery, values)
				if (!insertResult.rows || insertResult.rows.length === 0) {
					throw new Error(
						`Failed to revert DELETE for record ${recordId} in table ${tableName}`,
					)
				}
			} else {
				// UPDATE: restore old_data
				const revertData = entry.old_data
				if (!revertData || Object.keys(revertData).length === 0) {
					throw new Error(
						`No old_data available to revert for entry ${auditEntryId}`,
					)
				}

				const columns = Object.keys(revertData).filter(
					(k) => !pkColumns.includes(k),
				)
				this.validateColumnNames(columns)

				const setClauses = columns
					.map((col, idx) => `"${col}" = $${idx + 1}`)
					.join(', ')
				const values: unknown[] = columns.map((col) => revertData[col])

				const { whereClause, values: pkValues } = this.buildPkWhereClause(
					pkColumns,
					revertData,
					values.length,
				)
				values.push(...pkValues)

				const updateQuery = `
					UPDATE "${tableName}"
					SET ${setClauses}
					WHERE ${whereClause}
					RETURNING true as success
				`

				const updateResult = await client.query(updateQuery, values)
				if (!updateResult.rows || updateResult.rows.length === 0) {
					throw new Error(
						`Failed to revert record ${recordId} in table ${tableName} - no rows updated`,
					)
				}
			}

			await client.query('COMMIT')
		} catch (error) {
			await client.query('ROLLBACK')
			throw error
		} finally {
			client.release()
		}
	}

	async teardown(): Promise<void> {
		await this.ensurePool()

		// Drop triggers for each table using format() for safe identifier interpolation
		for (const tableName of this.tables) {
			const triggerName = `audit_trigger_${tableName}`
			const ddl = await this.pool.query(
				`SELECT format('DROP TRIGGER IF EXISTS %I ON %I', $1::text, $2::text) AS ddl`,
				[triggerName, tableName],
			)
			await this.pool.query(ddl.rows[0].ddl)
		}

		// Drop all table-specific trigger functions
		for (const tableName of this.tables) {
			const funcName = `audit_trigger_func_${tableName}`
			const ddl = await this.pool.query(
				`SELECT format('DROP FUNCTION IF EXISTS %I() CASCADE', $1::text) AS ddl`,
				[funcName],
			)
			await this.pool.query(ddl.rows[0].ddl)
		}

		// Drop audit_log table (cascades to partitions)
		await this.pool.query(`
			DROP TABLE IF EXISTS ${this.auditTable} CASCADE
		`)
	}

	async close(): Promise<void> {
		if (this.ownConnection) {
			await this.pool.end()
		}
	}
}
