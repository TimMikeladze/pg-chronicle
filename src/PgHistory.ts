import { SQL } from 'bun'
import type {
	AuditEntry,
	GetHistoryOptions,
	PaginatedResult,
	PgHistoryConfig,
	SearchOptions,
} from './types'

export class PgHistory {
	private sql: SQL
	private tables: string[]
	private ownConnection: boolean
	private schema: string = 'public'
	private primaryKeyCache: Map<string, string[]> = new Map()

	constructor(config: PgHistoryConfig) {
		this.tables = config.tables

		// Validate all table names before storing them (C1, I2)
		for (const tableName of this.tables) {
			this.validateTableName(tableName)
		}

		if (config.sql) {
			this.sql = config.sql
			this.ownConnection = false
		} else if (config.connection) {
			this.sql = new SQL(config.connection)
			this.ownConnection = true
		} else {
			throw new Error('PgHistory: No connection configuration provided')
		}
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
		const result = await this.sql`
			SELECT a.attname as column_name
			FROM pg_index i
			JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
			WHERE i.indrelid = ${tableName}::regclass
			AND i.indisprimary
			ORDER BY array_position(i.indkey, a.attnum)
		`

		const columns = result.map(
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
		if (this.tables.length === 0) {
			throw new Error('PgHistory: No tables configured for history tracking')
		}

		try {
			await this.setupInternal()
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
		const schemaResult = await this.sql`SELECT current_schema() as schema`
		this.schema = schemaResult[0]?.schema || 'public'

		// Create partitioned audit_log table
		await this.sql`
			CREATE TABLE IF NOT EXISTS audit_log (
				id BIGSERIAL,
				table_name TEXT NOT NULL,
				record_id TEXT NOT NULL,
				operation TEXT NOT NULL,
				changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				old_data JSONB,
				new_data JSONB,
				changed_by TEXT,
				metadata JSONB,
				PRIMARY KEY (id, table_name)
			) PARTITION BY LIST (table_name)
		`

		// Create partitions for each table
		for (const tableName of this.tables) {
			const partitionName = `audit_log_${tableName}`

			// Check if partition exists
			const exists = await this.sql`
				SELECT 1 FROM pg_tables
				WHERE schemaname = ${this.schema}
				AND tablename = ${partitionName}
			`

			if (exists.length === 0) {
				try {
					// Safe to use unsafe() here because tableName has been validated in constructor
					// through validateTableName() which ensures it contains only safe characters
					await this.sql.unsafe(`
						CREATE TABLE ${partitionName}
						PARTITION OF audit_log
						FOR VALUES IN ('${tableName}')
					`)
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
		await this.sql`
			CREATE INDEX IF NOT EXISTS idx_audit_old_data_gin
			ON audit_log USING GIN (old_data jsonb_path_ops)
		`

		await this.sql`
			CREATE INDEX IF NOT EXISTS idx_audit_new_data_gin
			ON audit_log USING GIN (new_data jsonb_path_ops)
		`

		await this.sql`
			CREATE INDEX IF NOT EXISTS idx_audit_changed_at
			ON audit_log (changed_at DESC)
		`

		await this.sql`
			CREATE INDEX IF NOT EXISTS idx_audit_record_id
			ON audit_log (table_name, record_id, changed_at DESC)
		`

		await this.sql`
			CREATE INDEX IF NOT EXISTS idx_audit_changed_by
			ON audit_log (changed_by)
		`

		// Create triggers for each table with table-specific trigger functions
		for (const tableName of this.tables) {
			const triggerName = `audit_trigger_${tableName}`
			const funcName = `audit_trigger_func_${tableName}`

			// Check if the target table exists
			const tableExists = await this.sql`
				SELECT 1 FROM pg_tables
				WHERE schemaname = ${this.schema}
				AND tablename = ${tableName}
			`

			if (tableExists.length === 0) {
				console.warn(
					`[pg-history] Table ${tableName} does not exist, skipping trigger creation`,
				)
				continue
			}

			// Get primary key columns for this table
			const pkColumns = await this.getPrimaryKeyColumns(tableName)

			// Create table-specific trigger function (idempotent)
			// Build the function body based on primary key configuration
			let functionBody: string

			if (pkColumns.length === 0) {
				// No primary key: use hash of all column values
				functionBody = `
				CREATE OR REPLACE FUNCTION ${funcName}()
				RETURNS TRIGGER AS $$
				DECLARE
					v_user_id TEXT;
					v_metadata JSONB;
				BEGIN
					-- Get user context from session variables if set
					BEGIN
						v_user_id := NULLIF(current_setting('audit.user_id', true), '');
						IF current_setting('audit.user_metadata', true) != '' THEN
							v_metadata := current_setting('audit.user_metadata', true)::jsonb;
						ELSE
							v_metadata := NULL;
						END IF;
					EXCEPTION WHEN OTHERS THEN
						v_user_id := NULL;
						v_metadata := NULL;
					END;

					IF (TG_OP = 'DELETE') THEN
						INSERT INTO audit_log (table_name, record_id, operation, old_data, changed_by, metadata)
						VALUES (TG_TABLE_NAME, md5(row_to_json(OLD)::text), TG_OP, to_jsonb(OLD), v_user_id, v_metadata);
						RETURN OLD;
					ELSIF (TG_OP = 'UPDATE') THEN
						INSERT INTO audit_log (table_name, record_id, operation, old_data, new_data, changed_by, metadata)
						VALUES (TG_TABLE_NAME, md5(row_to_json(NEW)::text), TG_OP, to_jsonb(OLD), to_jsonb(NEW), v_user_id, v_metadata);
						RETURN NEW;
					ELSIF (TG_OP = 'INSERT') THEN
						INSERT INTO audit_log (table_name, record_id, operation, new_data, changed_by, metadata)
						VALUES (TG_TABLE_NAME, md5(row_to_json(NEW)::text), TG_OP, to_jsonb(NEW), v_user_id, v_metadata);
						RETURN NEW;
					END IF;
				END;
				$$ LANGUAGE plpgsql;
				`
			} else if (pkColumns.length === 1) {
				// Single primary key
				const pkCol = pkColumns[0]
				functionBody = `
				CREATE OR REPLACE FUNCTION ${funcName}()
				RETURNS TRIGGER AS $$
				DECLARE
					v_user_id TEXT;
					v_metadata JSONB;
				BEGIN
					-- Get user context from session variables if set
					BEGIN
						v_user_id := NULLIF(current_setting('audit.user_id', true), '');
						IF current_setting('audit.user_metadata', true) != '' THEN
							v_metadata := current_setting('audit.user_metadata', true)::jsonb;
						ELSE
							v_metadata := NULL;
						END IF;
					EXCEPTION WHEN OTHERS THEN
						v_user_id := NULL;
						v_metadata := NULL;
					END;

					IF (TG_OP = 'DELETE') THEN
						INSERT INTO audit_log (table_name, record_id, operation, old_data, changed_by, metadata)
						VALUES (TG_TABLE_NAME, OLD.${pkCol}::text, TG_OP, to_jsonb(OLD), v_user_id, v_metadata);
						RETURN OLD;
					ELSIF (TG_OP = 'UPDATE') THEN
						INSERT INTO audit_log (table_name, record_id, operation, old_data, new_data, changed_by, metadata)
						VALUES (TG_TABLE_NAME, NEW.${pkCol}::text, TG_OP, to_jsonb(OLD), to_jsonb(NEW), v_user_id, v_metadata);
						RETURN NEW;
					ELSIF (TG_OP = 'INSERT') THEN
						INSERT INTO audit_log (table_name, record_id, operation, new_data, changed_by, metadata)
						VALUES (TG_TABLE_NAME, NEW.${pkCol}::text, TG_OP, to_jsonb(NEW), v_user_id, v_metadata);
						RETURN NEW;
					END IF;
				END;
				$$ LANGUAGE plpgsql;
				`
			} else {
				// Composite primary key: concatenate with '|' delimiter
				const pkExpressionsNew = pkColumns
					.map((col) => `COALESCE(NEW.${col}::text, '')`)
					.join(" || '|' || ")
				const pkExpressionsOld = pkColumns
					.map((col) => `COALESCE(OLD.${col}::text, '')`)
					.join(" || '|' || ")
				functionBody = `
				CREATE OR REPLACE FUNCTION ${funcName}()
				RETURNS TRIGGER AS $$
				DECLARE
					v_user_id TEXT;
					v_metadata JSONB;
				BEGIN
					-- Get user context from session variables if set
					BEGIN
						v_user_id := NULLIF(current_setting('audit.user_id', true), '');
						IF current_setting('audit.user_metadata', true) != '' THEN
							v_metadata := current_setting('audit.user_metadata', true)::jsonb;
						ELSE
							v_metadata := NULL;
						END IF;
					EXCEPTION WHEN OTHERS THEN
						v_user_id := NULL;
						v_metadata := NULL;
					END;

					IF (TG_OP = 'DELETE') THEN
						INSERT INTO audit_log (table_name, record_id, operation, old_data, changed_by, metadata)
						VALUES (TG_TABLE_NAME, ${pkExpressionsOld}, TG_OP, to_jsonb(OLD), v_user_id, v_metadata);
						RETURN OLD;
					ELSIF (TG_OP = 'UPDATE') THEN
						INSERT INTO audit_log (table_name, record_id, operation, old_data, new_data, changed_by, metadata)
						VALUES (TG_TABLE_NAME, ${pkExpressionsNew}, TG_OP, to_jsonb(OLD), to_jsonb(NEW), v_user_id, v_metadata);
						RETURN NEW;
					ELSIF (TG_OP = 'INSERT') THEN
						INSERT INTO audit_log (table_name, record_id, operation, new_data, changed_by, metadata)
						VALUES (TG_TABLE_NAME, ${pkExpressionsNew}, TG_OP, to_jsonb(NEW), v_user_id, v_metadata);
						RETURN NEW;
					END IF;
				END;
				$$ LANGUAGE plpgsql;
				`
			}

			await this.sql.unsafe(functionBody)

			// Check if trigger exists
			const triggerExists = await this.sql`
				SELECT 1 FROM pg_trigger
				WHERE tgname = ${triggerName}
			`

			if (triggerExists.length === 0) {
				try {
					// Safe to use unsafe() here because tableName has been validated in constructor
					await this.sql.unsafe(`
						CREATE TRIGGER ${triggerName}
						AFTER INSERT OR UPDATE OR DELETE ON ${tableName}
						FOR EACH ROW EXECUTE FUNCTION ${funcName}()
					`)
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

		// Create user correlation table
		await this.sql`
			CREATE TABLE IF NOT EXISTS audit_user_context (
				id BIGSERIAL PRIMARY KEY,
				user_id TEXT NOT NULL,
				metadata JSONB,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
			)
		`

		await this.sql`
			CREATE INDEX IF NOT EXISTS idx_audit_user_context_created_at
			ON audit_user_context (created_at DESC)
		`
	}

	async setUser(
		userId: string,
		metadata?: Record<string, unknown>,
	): Promise<void> {
		// Validate userId to prevent DOS attacks with huge strings
		this.validateStringInput(userId, 'userId', 255)

		// Store user context in PostgreSQL session variables
		// This allows triggers to access the user context
		await this.sql`SELECT set_config('audit.user_id', ${userId}, false)`

		if (metadata) {
			// Safely serialize metadata, catching circular references and other JSON errors
			let metadataJson: string
			try {
				metadataJson = JSON.stringify(metadata)
			} catch (error) {
				throw new Error(
					`Failed to serialize user metadata: ${error instanceof Error ? error.message : String(error)}`,
				)
			}

			// Validate serialized metadata length to prevent DOS
			if (metadataJson.length > 10000) {
				throw new Error(
					'User metadata exceeds maximum size of 10000 characters',
				)
			}

			await this
				.sql`SELECT set_config('audit.user_metadata', ${metadataJson}, false)`

			// Also insert into audit_user_context table for tracking
			// Cast to JSONB explicitly to ensure correct type handling
			await this.sql`
				INSERT INTO audit_user_context (user_id, metadata)
				VALUES (${userId}, ${metadataJson}::jsonb)
			`
		} else {
			await this.sql`SELECT set_config('audit.user_metadata', '', false)`

			// Also insert into audit_user_context table for tracking
			await this.sql`
				INSERT INTO audit_user_context (user_id, metadata)
				VALUES (${userId}, NULL)
			`
		}
	}

	async clearUser(): Promise<void> {
		// Clear user context from session variables
		await this.sql`SELECT set_config('audit.user_id', '', false)`
		await this.sql`SELECT set_config('audit.user_metadata', '', false)`
	}

	async getHistory(
		tableName: string,
		recordId: string,
		options: GetHistoryOptions = {},
	): Promise<PaginatedResult<AuditEntry>> {
		if (!this.tables.includes(tableName)) {
			throw new Error(
				`PgHistory: Table "${tableName}" is not configured for history tracking`,
			)
		}

		// Validate recordId to prevent DOS attacks
		this.validateStringInput(recordId, 'recordId', 500)

		// Validate and cap limit to prevent memory exhaustion (max 1000)
		const limit = this.validateLimit(options.limit, 50)
		const order = options.order || 'desc'

		// Validate cursor if provided
		if (options.cursor) {
			this.validateStringInput(options.cursor, 'cursor', 100)
		}

		let query: Promise<unknown[]>
		if (options.cursor) {
			// Cursor-based pagination
			if (order === 'desc') {
				query = this.sql`
					SELECT * FROM audit_log
					WHERE table_name = ${tableName}
					AND record_id = ${recordId}
					AND id < ${options.cursor}
					ORDER BY id DESC
					LIMIT ${limit + 1}
				`
			} else {
				query = this.sql`
					SELECT * FROM audit_log
					WHERE table_name = ${tableName}
					AND record_id = ${recordId}
					AND id > ${options.cursor}
					ORDER BY id ASC
					LIMIT ${limit + 1}
				`
			}
		} else {
			// First page
			if (order === 'desc') {
				query = this.sql`
					SELECT * FROM audit_log
					WHERE table_name = ${tableName}
					AND record_id = ${recordId}
					ORDER BY id DESC
					LIMIT ${limit + 1}
				`
			} else {
				query = this.sql`
					SELECT * FROM audit_log
					WHERE table_name = ${tableName}
					AND record_id = ${recordId}
					ORDER BY id ASC
					LIMIT ${limit + 1}
				`
			}
		}

		const rows = (await query) as Array<{
			id: number
			table_name: string
			record_id: string
			operation: string
			changed_at: string
			old_data: Record<string, unknown> | null
			new_data: Record<string, unknown> | null
			changed_by: string | null
			metadata: Record<string, unknown> | null
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
			changedBy: row.changed_by,
			metadata: row.metadata,
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
		if (options.tables.length === 0) {
			throw new Error(
				'PgHistory: At least one table must be specified for search',
			)
		}

		const invalidTables = options.tables.filter((t) => !this.tables.includes(t))
		if (invalidTables.length > 0) {
			throw new Error(
				`PgHistory: Tables not configured for history tracking: ${invalidTables.join(', ')}`,
			)
		}

		// Validate and cap limit to prevent memory exhaustion (max 1000)
		const limit = this.validateLimit(options.limit, 100)
		const tables = options.tables

		// Validate cursor if provided
		if (options.cursor) {
			this.validateStringInput(options.cursor, 'cursor', 100)
		}

		// Validate changedBy if provided
		if (options.changedBy) {
			this.validateStringInput(options.changedBy, 'changedBy', 255)
		}

		// Build WHERE conditions
		const conditions: string[] = []
		const params: unknown[] = []
		let paramIndex = 1

		// Table filter - use parameterized array for safety
		// Convert JS array to PostgreSQL array format
		const pgArray = `{${tables.join(',')}}`
		conditions.push(`table_name = ANY($${paramIndex}::text[])`)
		params.push(pgArray)
		paramIndex++

		// Full-text search on JSONB with wildcard escaping and length validation
		if (options.query) {
			// Validate query length to prevent DOS
			this.validateStringInput(options.query, 'query', 500)

			// Escape SQL wildcards (% and _) to prevent wildcard abuse
			// Users wanting wildcards should use proper JSONB operators instead
			const escapedQuery = options.query
				.replace(/\\/g, '\\\\') // Escape backslash first
				.replace(/%/g, '\\%') // Escape %
				.replace(/_/g, '\\_') // Escape _

			conditions.push(
				`(old_data::text ILIKE $${paramIndex} OR new_data::text ILIKE $${paramIndex})`,
			)
			params.push(`%${escapedQuery}%`)
			paramIndex++
		}

		// Operation filter
		if (options.operation) {
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

		// Changed by filter
		if (options.changedBy) {
			conditions.push(`changed_by = $${paramIndex}`)
			params.push(options.changedBy)
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
			SELECT * FROM audit_log
			WHERE ${whereClause}
			ORDER BY id DESC
			LIMIT $${paramIndex}
		`
		params.push(limit + 1)

		const rows = (await this.sql.unsafe(query, params)) as Array<{
			id: number
			table_name: string
			record_id: string
			operation: string
			changed_at: string
			old_data: Record<string, unknown> | null
			new_data: Record<string, unknown> | null
			changed_by: string | null
			metadata: Record<string, unknown> | null
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
			changedBy: row.changed_by,
			metadata: row.metadata,
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
		if (!this.tables.includes(tableName)) {
			throw new Error(
				`PgHistory: Table "${tableName}" is not configured for history tracking`,
			)
		}

		// Wrap entire revert operation in a transaction for consistency
		// Use Bun's transaction API
		return await this.sql.begin(async (tx) => {
			// Get the audit entry
			const [entry] = (await tx`
				SELECT * FROM audit_log
				WHERE id = ${auditEntryId}
				AND table_name = ${tableName}
				AND record_id = ${recordId}
			`) as Array<{
				id: number
				table_name: string
				record_id: string
				operation: string
				old_data: Record<string, unknown> | null
				new_data: Record<string, unknown> | null
			}>

			if (!entry) {
				throw new Error(
					`Audit entry ${auditEntryId} not found for ${tableName}:${recordId}`,
				)
			}

			// Determine which data to use for revert
			// For UPDATE: use old_data (state before the update)
			// For INSERT: use new_data (the inserted state)
			// For DELETE: use old_data (the deleted state)
			let revertData: Record<string, unknown>

			if (entry.operation === 'INSERT') {
				revertData = entry.new_data || {}
			} else {
				revertData = entry.old_data || {}
			}

			if (!revertData || Object.keys(revertData).length === 0) {
				throw new Error(`No data available to revert for entry ${auditEntryId}`)
			}

			// Get primary key columns for WHERE clause
			const pkColumns = await this.getPrimaryKeyColumns(tableName)

			// Build UPDATE statement dynamically
			// Filter out primary key columns from SET clause
			const columns = Object.keys(revertData).filter(
				(k) => !pkColumns.includes(k),
			)

			// Validate all column names from audit data to prevent SQL injection
			this.validateColumnNames(columns)
			this.validateColumnNames(pkColumns)

			const setClauses = columns
				.map((col, idx) => `${col} = $${idx + 1}`)
				.join(', ')
			const values = columns.map((col) => revertData[col])

			// Build WHERE clause based on primary key configuration
			let whereClause: string
			if (pkColumns.length === 0) {
				// No primary key: can't reliably update specific row
				throw new Error(
					`Cannot revert table "${tableName}" - no primary key defined`,
				)
			} else if (pkColumns.length === 1) {
				// Single primary key
				const pkCol = pkColumns[0]
				if (!pkCol) {
					throw new Error('Primary key column not found')
				}
				const pkValue = revertData[pkCol]
				if (pkValue === undefined) {
					throw new Error(
						`Primary key column "${pkCol}" not found in audit data`,
					)
				}
				whereClause = `${pkCol} = $${values.length + 1}`
				values.push(pkValue)
			} else {
				// Composite primary key
				const pkWhereClauses = pkColumns.map((col) => {
					const value = revertData[col]
					if (value === undefined) {
						throw new Error(
							`Primary key column "${col}" not found in audit data`,
						)
					}
					values.push(value)
					return `${col} = $${values.length}`
				})
				whereClause = pkWhereClauses.join(' AND ')
			}

			// Table name is validated in constructor, column names validated above
			const updateQuery = `
				UPDATE ${tableName}
				SET ${setClauses}
				WHERE ${whereClause}
				RETURNING true as success
			`

			const updateResult = await tx.unsafe(updateQuery, values)
			if (!updateResult || updateResult.length === 0) {
				throw new Error(
					`Failed to revert record ${recordId} in table ${tableName} - no rows updated`,
				)
			}

			// The revert UPDATE will be captured by trigger
			// Mark the newly created audit entry as a revert using a more reliable method
			// We use the fact that it's the most recent entry for this table/record
			// within this transaction, and we check it was just created
			const markedRows = await tx.unsafe(
				`
				UPDATE audit_log
				SET metadata = jsonb_set(
					COALESCE(metadata, '{}'::jsonb),
					'{revertedFrom}',
					to_jsonb($1::text)
				)
				WHERE id = (
					SELECT id FROM audit_log
					WHERE table_name = $2
					AND record_id = $3
					AND metadata->>'revertedFrom' IS NULL
					ORDER BY id DESC
					LIMIT 1
				)
				RETURNING id
			`,
				[auditEntryId, tableName, recordId],
			)

			if (!markedRows || markedRows.length === 0) {
				// Log warning but don't fail - the revert succeeded
				console.warn(
					`[pg-history] Failed to mark audit entry as revert for ${tableName}:${recordId}`,
				)
			}
		})
	}

	async teardown(): Promise<void> {
		// Drop triggers for each table
		for (const tableName of this.tables) {
			const triggerName = `audit_trigger_${tableName}`

			await this.sql.unsafe(`
				DROP TRIGGER IF EXISTS ${triggerName} ON ${tableName}
			`)
		}

		// Drop all table-specific trigger functions
		for (const tableName of this.tables) {
			const funcName = `audit_trigger_func_${tableName}`

			await this.sql.unsafe(`
				DROP FUNCTION IF EXISTS ${funcName}() CASCADE
			`)
		}

		// Drop user context table
		await this.sql`
			DROP TABLE IF EXISTS audit_user_context CASCADE
		`

		// Drop audit_log table (cascades to partitions)
		await this.sql`
			DROP TABLE IF EXISTS audit_log CASCADE
		`
	}

	async close(): Promise<void> {
		if (this.ownConnection) {
			await this.sql.close()
		}
	}
}
