import type { Pool } from 'pg'
import {
	SearchConcurrencyLimitError,
	SetupRequiredError,
	TableNotConfiguredError,
} from './errors'
import {
	attachPoolErrorHandler,
	consoleLogger,
	endPoolWithTimeout,
	type Logger,
} from './logger'
import { executeRevert } from './pg-history-revert'
import {
	setupAuditTable as extSetupAuditTable,
	setupIndexes as extSetupIndexes,
	setupPartitions as extSetupPartitions,
	triggerFuncNameFor,
	triggerNameFor,
	truncateTriggerNameFor,
} from './pg-history-setup'
import {
	buildAppendOnlyGuardSql,
	buildTriggerFunctionSql,
} from './pg-history-triggers'
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

/**
 * Raw audit_log row shape returned by getHistory/search queries.
 *
 * `id` is BIGSERIAL. node-postgres returns int8 as a STRING by default (to avoid
 * silent precision loss past 2^53), so it is typed `string` here — not `number`.
 * Do NOT install a numeric int8 type parser (e.g. `pg.types.setTypeParser(20,
 * Number)`); it would corrupt large ids and break cursor pagination.
 */
interface AuditRow {
	id: string
	table_name: string
	record_id: string
	operation: string
	changed_at: string
	old_data: Record<string, unknown> | null
	new_data: Record<string, unknown> | null
	db_user: string | null
	app_actor: string | null
	client_addr: string | null
}

export class PgHistory {
	private pool!: Pool
	private tables: string[]
	private excludeColumns: Record<string, string[]>
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
	/** Cap on concurrent search() queries (0 = unlimited). See maxConcurrentSearches. */
	private maxConcurrentSearches: number
	private activeSearches = 0
	/** When true, install the append-only guard trigger on audit_log. */
	private appendOnly: boolean
	/** When true, refuse to trigger tables without a primary key. */
	private requirePrimaryKey: boolean
	/** Guards close() against a double pool.end() (which pg rejects). */
	private closed = false

	constructor(config: PgHistoryConfig) {
		this.tables = config.tables
		this.logger = config.logger ?? consoleLogger
		this.excludeColumns = config.excludeColumns ?? {}
		this.maxConcurrentSearches = config.maxConcurrentSearches ?? 4
		this.appendOnly = config.appendOnly ?? false
		this.requirePrimaryKey = config.requirePrimaryKey ?? false

		for (const tableName of this.tables) this.validateTableName(tableName)
		for (const [tableName, cols] of Object.entries(this.excludeColumns)) {
			if (!this.tables.includes(tableName)) {
				throw new Error(
					`PgHistory: excludeColumns references unknown table "${tableName}"`,
				)
			}
			for (const col of cols) validateIdentifier(col, 'column')
		}

		if (config.pool) {
			this.pool = config.pool
			this.ownConnection = false
			attachPoolErrorHandler(this.pool, this.logger, 'PgHistory')
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
				attachPoolErrorHandler(this.pool, this.logger, 'PgHistory')
				this.pendingConnection = undefined
			})().catch((err) => {
				// Reset so the next call retries instead of re-awaiting the rejection
				this.poolPromise = null
				throw err
			})
		}
		await this.poolPromise
	}

	private validateTableName = (n: string) => validateIdentifier(n, 'table')
	private validateColumnName = (n: string) => validateIdentifier(n, 'column')
	private validateColumnNames = (ns: string[]) => extValidateColumnNames(ns)
	private validateStringInput = (v: string, f: string, m = 1000) =>
		extValidateStringInput(v, f, m)
	private validateLimit = (l: number | undefined, d: number) =>
		extValidateLimit(l, d)

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
				await this.withSetupLock(() => this.setupInternal())
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
	 * Run `fn` while holding a session-level advisory lock keyed to the current
	 * schema, so concurrent instances/processes serialize their DDL. The
	 * partition and trigger creation use check-then-create without IF NOT EXISTS;
	 * without this lock two replicas booting together can both pass the existence
	 * check and the loser's CREATE fails with "already exists", crashing startup.
	 */
	private async withSetupLock<T>(fn: () => Promise<T>): Promise<T> {
		// 73616469 = arbitrary stable namespace int, distinct from the archiver's.
		const SETUP_LOCK_NAMESPACE = 73_616_469
		const lockClient = await this.pool.connect()
		try {
			await lockClient.query(
				`SELECT pg_advisory_lock(hashtextextended('pg-history:setup:' || current_schema(), $1::bigint))`,
				[SETUP_LOCK_NAMESPACE],
			)
			return await fn()
		} finally {
			await lockClient
				.query(
					`SELECT pg_advisory_unlock(hashtextextended('pg-history:setup:' || current_schema(), $1::bigint))`,
					[SETUP_LOCK_NAMESPACE],
				)
				.catch(() => {})
			lockClient.release()
		}
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
		if (this.appendOnly) await this.setupAppendOnlyGuard()

		this.logger.info('Setup complete', {
			schema: this.schema,
			tables: this.tables.length,
		})
	}

	private async setupAuditTable(): Promise<void> {
		await extSetupAuditTable(
			this.pool,
			this.auditTable,
			this.schema,
			this.logger,
		)
	}

	private async setupPartitions(): Promise<void> {
		await extSetupPartitions(this.pool, this.schema, this.tables, this.logger)
	}

	private async setupIndexes(): Promise<void> {
		await extSetupIndexes(this.pool, this.auditTable, this.logger)
	}

	private async setupTriggers(): Promise<void> {
		this.logger.info('Setup phase: triggers', { count: this.tables.length })
		for (const tableName of this.tables) {
			await this.setupTableTrigger(tableName)
		}
	}

	/** Install the append-only guard trigger on audit_log (opt-in). */
	private async setupAppendOnlyGuard(): Promise<void> {
		this.logger.info('Setup phase: append-only guard on audit_log')
		const { func, trigger } = buildAppendOnlyGuardSql(this.schema)
		await this.pool.query(func)
		await this.pool.query(trigger)
	}

	/** Create (or skip if already present) the audit trigger for one table. */
	private async setupTableTrigger(tableName: string): Promise<void> {
		const triggerName = triggerNameFor(tableName)
		const funcName = triggerFuncNameFor(tableName)

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
		if (pkColumns.length === 0) {
			// No PK → per-row md5 record_id that changes every UPDATE, so entries
			// can't be correlated into one record's timeline. Never silent: warn,
			// and fail fast when the caller opted into requirePrimaryKey.
			if (this.requirePrimaryKey) {
				throw new Error(
					`PgHistory: table "${tableName}" has no primary key and requirePrimaryKey is set. ` +
						'Add a primary key (or a surrogate key) to get correlatable audit history.',
				)
			}
			this.logger.warn(
				'Table has no primary key; its audit history is NOT correlatable across UPDATEs (record_id is a per-row hash). Add a primary key or set requirePrimaryKey to enforce.',
				{ table: tableName },
			)
		}
		const tableExcludes = this.excludeColumns[tableName] ?? []
		// Excluding a PK column would break revert (PK is needed in WHERE)
		const pkSet = new Set(pkColumns)
		const conflicts = tableExcludes.filter((c) => pkSet.has(c))
		if (conflicts.length > 0) {
			throw new Error(
				`PgHistory: excludeColumns for "${tableName}" cannot include PK columns [${conflicts.join(', ')}]`,
			)
		}

		// Defense-in-depth: re-validate all identifiers immediately before
		// interpolation into PL/pgSQL, even though they were validated on construction.
		// The regex ensures only [a-zA-Z0-9_] chars, making SQL injection impossible.
		this.validateTableName(tableName)
		this.validateColumnName(funcName.replace(/^audit_trigger_func_/, ''))
		for (const col of pkColumns) {
			this.validateColumnName(col)
		}
		for (const col of tableExcludes) {
			this.validateColumnName(col)
		}

		const functionBody = buildTriggerFunctionSql({
			schema: this.schema,
			funcName,
			pkColumns,
			auditTable: this.auditTable,
			excludeColumns: tableExcludes,
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

		// Statement-level TRUNCATE trigger — reuses the same function (which has a
		// TG_OP='TRUNCATE' branch). Row triggers never fire on TRUNCATE, so without
		// this a bulk table wipe would leave no audit record.
		const truncateTriggerName = truncateTriggerNameFor(tableName)
		const truncateTriggerExists = await this.pool.query(
			`SELECT 1 FROM pg_trigger t
			JOIN pg_class c ON c.oid = t.tgrelid
			JOIN pg_namespace n ON n.oid = c.relnamespace
			WHERE t.tgname = $1
			AND c.relname = $2
			AND n.nspname = $3`,
			[truncateTriggerName, tableName, this.schema],
		)
		if (truncateTriggerExists.rows.length === 0) {
			try {
				const truncateDdl = await this.pool.query(
					`SELECT format(
						'CREATE TRIGGER %I AFTER TRUNCATE ON %I.%I FOR EACH STATEMENT EXECUTE FUNCTION %I.%I()',
						$1::text, $2::text, $3::text, $4::text, $5::text
					) AS ddl`,
					[truncateTriggerName, this.schema, tableName, this.schema, funcName],
				)
				await this.pool.query(truncateDdl.rows[0].ddl)
			} catch (error) {
				throw new Error(
					`Failed to create TRUNCATE trigger for table "${tableName}": ${error instanceof Error ? error.message : String(error)}`,
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
					`SELECT id, table_name, record_id, operation, changed_at, old_data, new_data, db_user, app_actor, client_addr FROM ${this.auditTable}
					WHERE ${whereClause}
					ORDER BY id DESC
					LIMIT $4`,
					[tableName, recordId, options.cursor, limit + 1],
				)
			} else {
				const whereClause = [...baseConditions, 'id > $3::bigint'].join(' AND ')
				queryResult = await this.pool.query(
					`SELECT id, table_name, record_id, operation, changed_at, old_data, new_data, db_user, app_actor, client_addr FROM ${this.auditTable}
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
				`SELECT id, table_name, record_id, operation, changed_at, old_data, new_data, db_user, app_actor, client_addr FROM ${this.auditTable}
				WHERE ${whereClause}
				ORDER BY id ${sortDir}
				LIMIT $3`,
				[tableName, recordId, limit + 1],
			)
		}

		const rows = queryResult.rows as AuditRow[]
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
				// Plain text ILIKE full scan with explicit ESCAPE so backslash-
				// escaped %/_ from user input are honored (PG default is literal).
				usesIlike = true
				const escaped = options.query
					.replace(/\\/g, '\\\\')
					.replace(/%/g, '\\%')
					.replace(/_/g, '\\_')
				conditions.push(
					`(old_data::text ILIKE $${paramIndex} ESCAPE '\\' OR new_data::text ILIKE $${paramIndex} ESCAPE '\\')`,
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
		// Both ILIKE (full scan) and JSON containment (GIN-indexed) are bounded
		// by SET LOCAL statement_timeout. JSON is usually fast but a bloated
		// index, large @> payload, or operator-class mismatch can still hang;
		// the 30s ceiling is generous for indexed search yet short enough that
		// a stuck query frees its connection slot.
		const timeoutMs = usesIlike ? 5000 : 30000
		const client = await this.pool.connect()
		try {
			await client.query('BEGIN')
			await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`)
			const result = await client.query(query, params)
			await client.query('COMMIT')
			return result
		} catch (error) {
			await client.query('ROLLBACK').catch((rollbackErr) => {
				this.logger.warn('ROLLBACK failed after query error', {
					rollbackErr,
					originalError: error instanceof Error ? error.message : String(error),
				})
			})
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
	private mapAuditRows(rows: AuditRow[]): AuditEntry[] {
		return rows.map((row) => ({
			id: row.id.toString(),
			tableName: row.table_name,
			recordId: row.record_id,
			operation: row.operation as 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE',
			changedAt: new Date(row.changed_at),
			oldData: row.old_data,
			newData: row.new_data,
			dbUser: row.db_user ?? null,
			appActor: row.app_actor ?? null,
			clientAddr: row.client_addr ?? null,
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

		// Bound concurrent searches to leave pool headroom for reads/reverts/health.
		// An unindexed ILIKE search pins a connection for seconds; without this a
		// few concurrent searches exhaust a small pool and DoS the whole service.
		if (
			this.maxConcurrentSearches > 0 &&
			this.activeSearches >= this.maxConcurrentSearches
		) {
			throw new SearchConcurrencyLimitError()
		}
		this.activeSearches++
		try {
			const { conditions, params, paramIndex, usesIlike } =
				await this.buildSearchConditions(options)

			const query = `
				SELECT id, table_name, record_id, operation, changed_at, old_data, new_data, db_user, app_actor, client_addr FROM ${this.auditTable}
				WHERE ${conditions.join(' AND ')}
				ORDER BY id DESC
				LIMIT $${paramIndex}
			`
			params.push(limit + 1)

			const queryResult = await this.runSearchQuery(query, params, usesIlike)
			return this.buildSearchResult(queryResult, limit)
		} finally {
			this.activeSearches--
		}
	}

	/** Build the paginated search result from a raw query result. */
	private buildSearchResult(
		queryResult: { rows: unknown[] },
		limit: number,
	): SearchPaginatedResult<AuditEntry> {
		const rows = queryResult.rows as AuditRow[]

		const hasMore = rows.length > limit
		const data = rows.slice(0, limit)
		const entries = this.mapAuditRows(data)
		const lastItem = data[data.length - 1]
		const cursorStr = hasMore && lastItem ? lastItem.id.toString() : null
		if (cursorStr) validateCursor(cursorStr) // guard brand cast
		const nextCursor = cursorStr ? (cursorStr as SearchCursor) : null

		return { data: entries, nextCursor, hasMore }
	}

	/**
	 * Revert a record to the state captured in an audit entry.
	 *
	 * IMPORTANT: Revert operations trigger their own audit entries because the
	 * INSERT/UPDATE/DELETE on the user table fires the audit trigger.
	 *
	 * Default: `suppressAuditTriggers: false` — reverts ARE recorded, so the
	 * audit trail never silently loses the fact that data was changed back
	 * (repudiation defense). This is also the least-privilege-friendly path: it
	 * needs no special role.
	 *
	 * Pass `suppressAuditTriggers: true` to skip audit rows for the revert
	 * operation itself (avoids "revert of revert" chains). This uses PostgreSQL's
	 * `session_replication_role = 'replica'`, which requires SUPERUSER or the
	 * `pg_replication` role (PostgreSQL 16+) and is scoped to the transaction.
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

		const suppressTriggers = options.suppressAuditTriggers ?? false

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
			await client.query('ROLLBACK').catch((rollbackErr) => {
				this.logger.warn('ROLLBACK failed during revert', {
					rollbackErr,
					originalError: error instanceof Error ? error.message : String(error),
				})
			})
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
			const triggerName = triggerNameFor(tableName)
			const ddl = await this.pool.query(
				`SELECT format('DROP TRIGGER IF EXISTS %I ON %I.%I', $1::text, $2::text, $3::text) AS ddl`,
				[triggerName, this.schema, tableName],
			)
			await this.pool.query(ddl.rows[0].ddl)

			const truncateTriggerName = truncateTriggerNameFor(tableName)
			const truncDdl = await this.pool.query(
				`SELECT format('DROP TRIGGER IF EXISTS %I ON %I.%I', $1::text, $2::text, $3::text) AS ddl`,
				[truncateTriggerName, this.schema, tableName],
			)
			await this.pool.query(truncDdl.rows[0].ddl)
		}

		for (const tableName of this.tables) {
			const funcName = triggerFuncNameFor(tableName)
			const ddl = await this.pool.query(
				`SELECT format('DROP FUNCTION IF EXISTS %I.%I() CASCADE', $1::text, $2::text) AS ddl`,
				[this.schema, funcName],
			)
			await this.pool.query(ddl.rows[0].ddl)
		}

		// Drop audit_log table (cascades to partitions and the append-only guard
		// trigger). The guard FUNCTION is not owned by the table, so drop it too.
		await this.pool.query(`
			DROP TABLE IF EXISTS ${this.auditTable} CASCADE
		`)
		const guardDdl = await this.pool.query(
			`SELECT format('DROP FUNCTION IF EXISTS %I.%I() CASCADE', $1::text, $2::text) AS ddl`,
			[this.schema, 'audit_log_append_guard'],
		)
		await this.pool.query(guardDdl.rows[0].ddl)

		// Reset setup state so a subsequent setup() call re-runs DDL instead of
		// short-circuiting. Without this, queries after teardown() would fail with
		// obscure "relation does not exist" errors.
		this.setupComplete = false
		this.setupPromise = null
		// Invalidate cached schema facts. audit_log is recreated by setup() WITHOUT
		// the archiver's soft_deleted_at column; a stale cached "column exists"
		// would make every getHistory/search append `soft_deleted_at IS NULL` and
		// fail. Primary keys are re-derived on next use.
		this.invalidateSoftDeleteColumnCache()
		this.primaryKeyCache.clear()
	}

	async close(timeoutMs: number = 30_000): Promise<void> {
		if (!this.ownConnection) return
		// Idempotent: pg's Pool.end() rejects on a second call. Shutdown paths that
		// fire SIGTERM+SIGINT, or call close() alongside shared cleanup, must not throw.
		if (this.closed) return
		this.closed = true
		await endPoolWithTimeout(this.pool, timeoutMs, this.logger, 'PgHistory')
	}
}
