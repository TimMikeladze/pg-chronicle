import type { Pool } from 'pg'
import { SetupRequiredError, TableNotConfiguredError } from './errors'
import { consoleLogger, type Logger } from './logger'
import { executeRevert } from './pg-history-revert'
import { buildTriggerFunctionSql } from './pg-history-triggers'
import {
	validateColumnNames as extValidateColumnNames,
	validateLimit as extValidateLimit,
	validateStringInput as extValidateStringInput,
	validateCursor,
	validateIdentifier,
} from './pg-history-validators'
import type {
	AuditEntry,
	GetHistoryOptions,
	PaginatedResult,
	PgHistoryConfig,
	SearchCursor,
	SearchOptions,
	SearchPaginatedResult,
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
	private setupPromise: Promise<void> | null = null
	private softDeleteColumnExists: boolean | undefined
	private softDeleteColumnPromise: Promise<boolean> | null = null
	/** Unix ms timestamp until which we know the column is absent (negative TTL). */
	private softDeleteColumnAbsentUntil: number = 0
	private logger: Logger

	constructor(config: PgHistoryConfig) {
		this.tables = config.tables
		this.logger = config.logger ?? consoleLogger

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
			})().catch((err) => {
				// Reset so the next call retries instead of re-awaiting the rejection
				this.poolPromise = null
				throw err
			})
		}
		await this.poolPromise
	}

	// Instance-level wrappers around the pure validators.
	// These exist because the rest of the class uses `this.validateX(...)`
	// rather than importing the standalone functions everywhere.
	private validateTableName(name: string): void {
		validateIdentifier(name, 'table')
	}
	private validateColumnName(name: string): void {
		validateIdentifier(name, 'column')
	}
	private validateColumnNames(names: string[]): void {
		extValidateColumnNames(names)
	}
	private validateStringInput(
		value: string,
		fieldName: string,
		maxLength = 1000,
	): void {
		extValidateStringInput(value, fieldName, maxLength)
	}
	private validateLimit(
		limit: number | undefined,
		defaultLimit: number,
	): number {
		return extValidateLimit(limit, defaultLimit)
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

		// Schema-qualified regclass cast avoids search_path ambiguity.
		const result = await this.pool.query(
			`SELECT a.attname as column_name
			FROM pg_index i
			JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
			WHERE i.indrelid = (quote_ident($1) || '.' || quote_ident($2))::regclass
			AND i.indisprimary
			ORDER BY array_position(i.indkey, a.attnum)`,
			[this.schema, tableName],
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
		// Dedup concurrent calls — only one DDL run at a time.
		// After success, setupComplete short-circuits future calls immediately.
		if (this.setupComplete) return
		if (this.setupPromise) return this.setupPromise

		this.setupPromise = (async () => {
			await this.ensurePool()

			if (this.tables.length === 0) {
				throw new Error('PgHistory: No tables configured for history tracking')
			}

			try {
				await this.setupInternal()
				this.setupComplete = true
			} catch (error) {
				const errorMessage =
					error instanceof Error ? error.message : String(error)
				throw new Error(
					`PgHistory setup failed: ${errorMessage}. You may need to call teardown() to clean up partial state.`,
				)
			}
		})().finally(() => {
			// Reset so a subsequent call after failure can retry
			if (!this.setupComplete) this.setupPromise = null
		})

		return this.setupPromise
	}

	/**
	 * Internal setup implementation — delegates to phase helpers so each can be
	 * read and reasoned about independently.
	 */
	private async setupInternal(): Promise<void> {
		// Detect current schema (C2)
		const schemaResult = await this.pool.query(
			'SELECT current_schema() as schema',
		)
		const detectedSchema = schemaResult.rows[0]?.schema || 'public'
		validateIdentifier(detectedSchema, 'schema')
		this.schema = detectedSchema

		// DDL auto-commits in PG, so partial failures leave earlier phases applied
		// but later ones pending.  Each phase is idempotent (IF NOT EXISTS), so
		// calling setup() again after a partial failure is safe.
		await this.setupAuditTable()
		await this.setupPartitions()
		await this.setupIndexes()
		await this.setupTriggers()

		this.logger.info('Setup complete', {
			schema: this.schema,
			tables: this.tables.length,
		})
	}

	/** Phase 1: Create the partitioned audit_log parent table. */
	private async setupAuditTable(): Promise<void> {
		this.logger.info('Setup phase: audit_log parent table', {
			schema: this.schema,
		})
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
	}

	/** Phase 2: Create per-table partitions of audit_log. */
	private async setupPartitions(): Promise<void> {
		this.logger.info('Setup phase: partitions', { count: this.tables.length })
		for (const tableName of this.tables) {
			const partitionName = `audit_log_${tableName}`

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
					throw new Error(
						`Failed to create partition for table "${tableName}": ${error instanceof Error ? error.message : String(error)}`,
					)
				}
			} else {
				this.logger.debug('Partition already exists, skipping', {
					partition: partitionName,
				})
			}
		}
	}

	/** Phase 3: Create GIN and B-tree indexes on audit_log. */
	private async setupIndexes(): Promise<void> {
		this.logger.info('Setup phase: indexes')
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
	}

	/** Phase 4: Create trigger functions and triggers for each tracked table. */
	private async setupTriggers(): Promise<void> {
		this.logger.info('Setup phase: triggers', { count: this.tables.length })
		for (const tableName of this.tables) {
			await this.setupTableTrigger(tableName)
		}
	}

	/** Create (or skip if already present) the audit trigger for one table. */
	private async setupTableTrigger(tableName: string): Promise<void> {
		const triggerName = `audit_trigger_${tableName}`
		const funcName = `audit_trigger_func_${tableName}`

		const tableExists = await this.pool.query(
			'SELECT 1 FROM pg_tables WHERE schemaname = $1 AND tablename = $2',
			[this.schema, tableName],
		)
		if (tableExists.rows.length === 0) {
			this.logger.warn('Table does not exist, skipping trigger creation', {
				table: tableName,
			})
			return
		}

		const pkColumns = await this.getPrimaryKeyColumns(tableName)

		// Defense-in-depth: re-validate all identifiers immediately before
		// interpolation into PL/pgSQL, even though they were validated on construction.
		// The regex ensures only [a-zA-Z0-9_] chars, making SQL injection impossible.
		this.validateTableName(tableName)
		this.validateColumnName(funcName.replace(/^audit_trigger_func_/, ''))
		for (const col of pkColumns) {
			this.validateColumnName(col)
		}

		const functionBody = buildTriggerFunctionSql({
			schema: this.schema,
			funcName,
			pkColumns,
			auditTable: this.auditTable,
		})
		await this.pool.query(functionBody)

		// Scope trigger existence check to this specific table to avoid
		// false-positive skips when another table shares the trigger name.
		const triggerExists = await this.pool.query(
			`SELECT 1 FROM pg_trigger t
			JOIN pg_class c ON c.oid = t.tgrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE t.tgname = $1
			AND c.relname = $2
			AND n.nspname = $3`,
			[triggerName, tableName, this.schema],
		)

		if (triggerExists.rows.length === 0) {
			try {
				const triggerDdl = await this.pool.query(
					`SELECT format(
						'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION %I.%I()',
						$1::text, $2::text, $3::text, $4::text, $5::text
					) AS ddl`,
					[triggerName, this.schema, tableName, this.schema, funcName],
				)
				await this.pool.query(triggerDdl.rows[0].ddl)
			} catch (error) {
				throw new Error(
					`Failed to create trigger for table "${tableName}": ${error instanceof Error ? error.message : String(error)}`,
				)
			}
		} else {
			this.logger.debug('Trigger already exists, skipping', {
				trigger: triggerName,
				table: tableName,
			})
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

	/**
	 * Check if the soft_deleted_at column exists on audit_log.
	 * This column is added by the archiver setup, not by PgHistory.setup().
	 *
	 * Positive result is cached permanently — the column is stable once added.
	 * Negative result uses a 10-second TTL: bounds per-request query rate in
	 * environments where the archiver schema hasn't been set up yet, while still
	 * detecting the column within 10 s of setupArchiverSchema() running.
	 */
	private async hasSoftDeleteColumn(): Promise<boolean> {
		if (this.softDeleteColumnExists === true) {
			return true
		}
		if (Date.now() < this.softDeleteColumnAbsentUntil) {
			return false
		}
		if (!this.softDeleteColumnPromise) {
			this.softDeleteColumnPromise = this.pool
				.query(
					`SELECT 1 FROM information_schema.columns
					WHERE table_schema = $1
					AND table_name = 'audit_log'
					AND column_name = 'soft_deleted_at'`,
					[this.schema],
				)
				.then((result) => {
					const exists = result.rows.length > 0
					if (exists) {
						this.softDeleteColumnExists = true
					} else {
						this.softDeleteColumnAbsentUntil = Date.now() + 10_000
					}
					return exists
				})
				.finally(() => {
					this.softDeleteColumnPromise = null
				})
		}
		return this.softDeleteColumnPromise
	}

	/**
	 * Invalidate the primary key cache for a table (or all tables if omitted).
	 * Call this after schema changes like ALTER TABLE ... ADD/DROP CONSTRAINT.
	 */
	invalidatePrimaryKeyCache(tableName?: string): void {
		if (tableName) {
			this.primaryKeyCache.delete(tableName)
		} else {
			this.primaryKeyCache.clear()
		}
	}

	/**
	 * Invalidate the cached soft-delete column existence check.
	 * Call this after the archiver has set up its schema extensions to force
	 * an immediate re-check instead of waiting for the 10-second negative TTL.
	 */
	invalidateSoftDeleteColumnCache(): void {
		this.softDeleteColumnExists = undefined
		this.softDeleteColumnAbsentUntil = 0
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
		validateCursor(options.cursor)

		// Build WHERE conditions — matching the pattern used in search().
		// Records that have been soft-deleted must not appear in history results
		// since they are scheduled for permanent deletion.
		const hasSoftDelete = await this.hasSoftDeleteColumn()
		const baseConditions = ['table_name = $1', 'record_id = $2']
		if (hasSoftDelete) baseConditions.push('soft_deleted_at IS NULL')

		let queryResult: { rows: unknown[] }
		if (options.cursor) {
			// Cursor-based pagination — cast cursor to bigint explicitly so the
			// query planner uses the idx_audit_record_id index predictably
			if (order === 'desc') {
				const whereClause = [...baseConditions, 'id < $3::bigint'].join(' AND ')
				queryResult = await this.pool.query(
					`SELECT id, table_name, record_id, operation, changed_at, old_data, new_data FROM ${this.auditTable}
					WHERE ${whereClause}
					ORDER BY id DESC
					LIMIT $4`,
					[tableName, recordId, options.cursor, limit + 1],
				)
			} else {
				const whereClause = [...baseConditions, 'id > $3::bigint'].join(' AND ')
				queryResult = await this.pool.query(
					`SELECT id, table_name, record_id, operation, changed_at, old_data, new_data FROM ${this.auditTable}
					WHERE ${whereClause}
					ORDER BY id ASC
					LIMIT $4`,
					[tableName, recordId, options.cursor, limit + 1],
				)
			}
		} else {
			// First page
			const whereClause = baseConditions.join(' AND ')
			const sortDir = order === 'desc' ? 'DESC' : 'ASC'
			queryResult = await this.pool.query(
				`SELECT id, table_name, record_id, operation, changed_at, old_data, new_data FROM ${this.auditTable}
				WHERE ${whereClause}
				ORDER BY id ${sortDir}
				LIMIT $3`,
				[tableName, recordId, limit + 1],
			)
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
		const entries = this.mapAuditRows(data)
		const lastItem = data[data.length - 1]
		const nextCursor = hasMore && lastItem ? lastItem.id.toString() : null

		return { data: entries, nextCursor, hasMore }
	}

	/** Build the WHERE clause params for search(). Returns conditions, params, and a flag indicating ILIKE use. */
	private async buildSearchConditions(options: SearchOptions): Promise<{
		conditions: string[]
		params: unknown[]
		paramIndex: number
		usesIlike: boolean
	}> {
		const conditions: string[] = []
		const params: unknown[] = []
		let paramIndex = 1
		let usesIlike = false

		if (await this.hasSoftDeleteColumn()) {
			conditions.push('soft_deleted_at IS NULL')
		}

		// Table filter — pg driver converts JS array to Postgres text[]
		conditions.push(`table_name = ANY($${paramIndex}::text[])`)
		params.push(options.tables)
		paramIndex++

		if (options.query) {
			this.validateStringInput(options.query, 'query', 500)
			const trimmed = options.query.trim()

			if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
				// JSON containment — uses GIN index
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
				// Plain text — ILIKE full scan (statement timeout applied at execution)
				usesIlike = true
				const escaped = options.query
					.replace(/\\/g, '\\\\')
					.replace(/%/g, '\\%')
					.replace(/_/g, '\\_')
				conditions.push(
					`(old_data::text ILIKE $${paramIndex} OR new_data::text ILIKE $${paramIndex})`,
				)
				params.push(`%${escaped}%`)
				paramIndex++
			}
		}

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

		if (options.cursor) {
			// Cast to bigint for predictable index usage
			conditions.push(`id < $${paramIndex}::bigint`)
			params.push(options.cursor)
			paramIndex++
		}

		return { conditions, params, paramIndex, usesIlike }
	}

	/**
	 * Execute a search query. ILIKE queries run on a dedicated client with a
	 * 5-second statement timeout to prevent unindexed full scans from stalling
	 * the pool.
	 */
	private async runSearchQuery(
		query: string,
		params: unknown[],
		usesIlike: boolean,
	): Promise<{ rows: unknown[] }> {
		if (!usesIlike) {
			return this.pool.query(query, params)
		}

		// Use SET LOCAL inside an explicit transaction so the timeout is scoped
		// to this query only. SET LOCAL auto-reverts when the transaction ends,
		// avoiding the dirty-connection issue where a timed-out statement leaves
		// the session-level timeout set on a connection returned to the pool.
		const client = await this.pool.connect()
		try {
			await client.query('BEGIN')
			await client.query('SET LOCAL statement_timeout = 5000') // 5 s
			const result = await client.query(query, params)
			await client.query('COMMIT')
			return result
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {})
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
			client.release()
		}
	}

	/** Map raw audit_log rows to typed AuditEntry objects. */
	private mapAuditRows(
		rows: Array<{
			id: number
			table_name: string
			record_id: string
			operation: string
			changed_at: string
			old_data: Record<string, unknown> | null
			new_data: Record<string, unknown> | null
		}>,
	): AuditEntry[] {
		return rows.map((row) => ({
			id: row.id.toString(),
			tableName: row.table_name,
			recordId: row.record_id,
			operation: row.operation as 'INSERT' | 'UPDATE' | 'DELETE',
			changedAt: new Date(row.changed_at),
			oldData: row.old_data,
			newData: row.new_data,
		}))
	}

	async search(
		options: SearchOptions,
	): Promise<SearchPaginatedResult<AuditEntry>> {
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

		const limit = this.validateLimit(options.limit, 100)
		validateCursor(options.cursor)

		const { conditions, params, paramIndex, usesIlike } =
			await this.buildSearchConditions(options)

		const query = `
			SELECT id, table_name, record_id, operation, changed_at, old_data, new_data FROM ${this.auditTable}
			WHERE ${conditions.join(' AND ')}
			ORDER BY id DESC
			LIMIT $${paramIndex}
		`
		params.push(limit + 1)

		const queryResult = await this.runSearchQuery(query, params, usesIlike)
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
		const entries = this.mapAuditRows(data)
		const lastItem = data[data.length - 1]
		const nextCursor =
			hasMore && lastItem ? (lastItem.id.toString() as SearchCursor) : null

		return { data: entries, nextCursor, hasMore }
	}

	/**
	 * Revert a record to the state captured in an audit entry.
	 *
	 * IMPORTANT: Revert operations normally trigger their own audit entries
	 * because the INSERT/UPDATE/DELETE on the user table fires the audit trigger.
	 * This can create "revert of revert of revert" chains that grow the audit log.
	 *
	 * Pass `suppressAuditTriggers: true` (default) to skip audit rows for the
	 * revert operation itself. This uses PostgreSQL's `session_replication_role`
	 * which suppresses user-defined triggers for the session duration — scoped
	 * to the transaction because we restore it before COMMIT.
	 *
	 * Pass `suppressAuditTriggers: false` to get an audit trail that includes
	 * the revert operations themselves.
	 */
	async revert(
		tableName: string,
		recordId: string,
		auditEntryId: string,
		options: { suppressAuditTriggers?: boolean } = {},
	): Promise<void> {
		this.ensureSetup()

		if (!this.tables.includes(tableName)) {
			throw new TableNotConfiguredError(tableName)
		}

		const suppressTriggers = options.suppressAuditTriggers ?? true

		// Fetch PK columns before opening the transaction so we fail fast on
		// a missing PK without holding a client connection.
		const pkColumns = await this.getPrimaryKeyColumns(tableName)

		// Wrap revert in a transaction; executeRevert does the SQL work.
		const softDeleteExists = await this.hasSoftDeleteColumn()
		const client = await this.pool.connect()
		try {
			await client.query('BEGIN')
			await executeRevert({
				client,
				schema: this.schema,
				auditTable: this.auditTable,
				tableName,
				recordId,
				auditEntryId,
				pkColumns,
				suppressAuditTriggers: suppressTriggers,
				hasSoftDeleteColumn: softDeleteExists,
			})
			await client.query('COMMIT')
		} catch (error) {
			await client.query('ROLLBACK').catch(() => {})
			throw error
		} finally {
			client.release()
		}
	}

	async teardown(): Promise<void> {
		await this.ensurePool()

		// Schema-qualify both the trigger table and the trigger function to avoid
		// search_path resolution issues in non-default schemas.
		for (const tableName of this.tables) {
			const triggerName = `audit_trigger_${tableName}`
			const ddl = await this.pool.query(
				`SELECT format('DROP TRIGGER IF EXISTS %I ON %I.%I', $1::text, $2::text, $3::text) AS ddl`,
				[triggerName, this.schema, tableName],
			)
			await this.pool.query(ddl.rows[0].ddl)
		}

		for (const tableName of this.tables) {
			const funcName = `audit_trigger_func_${tableName}`
			const ddl = await this.pool.query(
				`SELECT format('DROP FUNCTION IF EXISTS %I.%I() CASCADE', $1::text, $2::text) AS ddl`,
				[this.schema, funcName],
			)
			await this.pool.query(ddl.rows[0].ddl)
		}

		// Drop audit_log table (cascades to partitions)
		await this.pool.query(`
			DROP TABLE IF EXISTS ${this.auditTable} CASCADE
		`)

		// Reset setup state so a subsequent setup() call re-runs DDL instead of
		// short-circuiting. Without this, queries after teardown() would fail with
		// obscure "relation does not exist" errors.
		this.setupComplete = false
		this.setupPromise = null
	}

	async close(): Promise<void> {
		if (this.ownConnection) {
			await this.pool.end()
		}
	}
}
