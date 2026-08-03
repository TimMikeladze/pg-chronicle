/**
 * SQL builder helpers for PgHistory audit triggers.
 *
 * Extracted from PgHistory.ts so the class stays focused on orchestration
 * rather than string templating. All identifiers passed in are assumed to
 * have been validated by the caller (validateIdentifier from validators).
 *
 * SECURITY DEFINER + search_path:
 *   Generated trigger functions run with the privileges of the function
 *   owner, not the calling user. This ensures audit inserts succeed even
 *   when the calling user lacks INSERT on audit_log (typical for least-
 *   privilege application roles). `SET search_path = pg_catalog, public`
 *   pins identifier resolution to defeat search_path hijacking.
 *
 *   IMPLICATION: whoever runs setup() becomes the function owner. If that
 *   is a superuser, audit inserts effectively run with superuser privilege.
 *   For least-privilege deployments, create a dedicated `pg_history_writer`
 *   role with INSERT on audit_log, run setup() as that role, OR after
 *   setup() do `ALTER FUNCTION audit_trigger_func_<t>() OWNER TO pg_history_writer`.
 */

export interface BuildTriggerFunctionArgs {
	/** Schema to create the function in (e.g., "public") */
	schema: string
	/** Name of the trigger function to create (e.g., "audit_trigger_func_users") */
	funcName: string
	/** Primary key column names on the target table */
	pkColumns: string[]
	/** Schema-qualified audit table expression (e.g., '"public"."audit_log"') */
	auditTable: string
	/**
	 * Column names to strip from old_data / new_data before insertion into
	 * audit_log. Use to keep secrets/PII out of the audit trail. Each name
	 * must be a validated identifier (caller responsibility).
	 */
	excludeColumns?: string[]
}

/**
 * Build the append-only guard for audit_log. The BEFORE UPDATE OR DELETE trigger
 * rejects mutations unless the session set `pg_history.maintenance = 'on'` (which
 * the archiver does for its own lifecycle operations). Schema is a validated
 * identifier (caller responsibility).
 */
export function buildAppendOnlyGuardSql(schema: string): {
	func: string
	trigger: string
	guardFuncName: string
	guardTriggerName: string
} {
	const guardFuncName = 'audit_log_append_guard'
	const guardTriggerName = 'audit_log_append_guard'
	const func = `
CREATE OR REPLACE FUNCTION "${schema}"."${guardFuncName}"()
RETURNS TRIGGER AS $$
BEGIN
	IF current_setting('pg_history.maintenance', true) IS DISTINCT FROM 'on' THEN
		RAISE EXCEPTION 'audit_log is append-only: % is not permitted outside pghistory maintenance context', TG_OP
			USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF (TG_OP = 'DELETE') THEN
		RETURN OLD;
	END IF;
	RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;
	`
	// CREATE OR REPLACE TRIGGER (PG14+) keeps setup idempotent.
	const trigger = `CREATE OR REPLACE TRIGGER "${guardTriggerName}" BEFORE UPDATE OR DELETE ON "${schema}"."audit_log" FOR EACH ROW EXECUTE FUNCTION "${schema}"."${guardFuncName}"()`
	return { func, trigger, guardFuncName, guardTriggerName }
}

/**
 * Build the JSONB payload expression for OLD or NEW. When excludeColumns is
 * non-empty, columns are stripped via the `-` operator chain so audited
 * history never contains the listed columns. Identifier validation is the
 * caller's responsibility (callers in PgHistory validate via validateColumnName
 * before reaching the builder).
 */
function jsonbPayload(rowVar: 'NEW' | 'OLD', excludeColumns: string[]): string {
	const base = `to_jsonb(${rowVar})`
	if (excludeColumns.length === 0) return base
	const stripped = excludeColumns
		.map((col) => `- '${col.replace(/'/g, "''")}'`)
		.join(' ')
	return `(${base} ${stripped})`
}

/**
 * Builds the CREATE OR REPLACE FUNCTION SQL for a table-specific audit trigger.
 *
 * The generated function branches on TG_OP (INSERT/UPDATE/DELETE) and writes
 * a row to the audit log with the appropriate old_data / new_data payloads.
 * record_id is derived from the primary key:
 *   - 0 PK columns: md5(row_to_json) — stable hash
 *   - 1 PK column: column value cast to text
 *   - N PK columns: columns joined with '|' delimiter
 */
export function buildTriggerFunctionSql(
	args: BuildTriggerFunctionArgs,
): string {
	const { schema, funcName, pkColumns, auditTable } = args
	const excludeColumns = args.excludeColumns ?? []
	const newPayload = jsonbPayload('NEW', excludeColumns)
	const oldPayload = jsonbPayload('OLD', excludeColumns)

	// Actor / "who" columns recorded on every audit row. These are appended to
	// each INSERT's column list and VALUES list:
	//   db_user     — current_user (the role that executed the DML)
	//   app_actor   — current_setting('pg_history.actor', true): the application
	//                 end-user, NULL unless the app runs SET LOCAL pg_history.actor
	//   client_addr — inet_client_addr(): NULL for local socket connections
	// current_setting(..., true) uses missing_ok=true so an unset actor yields
	// NULL instead of raising. Values reference only pg_catalog builtins, so the
	// pinned search_path keeps them safe under SECURITY DEFINER.
	const actorCols = 'db_user, app_actor, client_addr'
	// NULLIF(..., '') normalizes an unset/empty actor to NULL. current_setting
	// with missing_ok=true returns NULL when the GUC was never referenced on the
	// backend, but '' once the placeholder exists (e.g. a pooled connection that
	// previously ran SET LOCAL) — both should record as "no actor".
	const actorVals =
		"current_user, NULLIF(current_setting('pg_history.actor', true), ''), inet_client_addr()"

	if (pkColumns.length === 0) {
		// No primary key: use md5 hash of the full row as record_id.
		// NOTE: For UPDATE operations, record_id is md5(NEW row) — it changes on
		// every update because it reflects the new values. This means getHistory()
		// queries by record_id will NOT correlate UPDATE entries with preceding
		// INSERT entries for no-PK tables. Use tables with explicit primary keys
		// for complete, queryable audit history.
		return `
CREATE OR REPLACE FUNCTION "${schema}"."${funcName}"()
RETURNS TRIGGER AS $$
BEGIN
	IF (TG_OP = 'TRUNCATE') THEN
		-- Statement-level TRUNCATE has no OLD/NEW rows; record a single marker
		-- entry so bulk table wipes are never silently absent from the trail.
		INSERT INTO ${auditTable} (table_name, record_id, operation, ${actorCols})
		VALUES (TG_TABLE_NAME, '(truncate)', 'TRUNCATE', ${actorVals});
		RETURN NULL;
	ELSIF (TG_OP = 'DELETE') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, old_data, ${actorCols})
		VALUES (TG_TABLE_NAME, md5(row_to_json(OLD)::text), TG_OP, ${oldPayload}, ${actorVals});
		RETURN OLD;
	ELSIF (TG_OP = 'UPDATE') THEN
		-- Skip audit insert for idempotent updates (OLD == NEW). PostgreSQL
		-- fires row triggers for every UPDATE statement regardless of whether
		-- any column actually changed; without this guard, "UPDATE x SET c = c"
		-- would bloat audit_log with no-op rows.
		IF OLD IS DISTINCT FROM NEW THEN
			INSERT INTO ${auditTable} (table_name, record_id, operation, old_data, new_data, ${actorCols})
			VALUES (TG_TABLE_NAME, md5(row_to_json(NEW)::text), TG_OP, ${oldPayload}, ${newPayload}, ${actorVals});
		END IF;
		RETURN NEW;
	ELSIF (TG_OP = 'INSERT') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, new_data, ${actorCols})
		VALUES (TG_TABLE_NAME, md5(row_to_json(NEW)::text), TG_OP, ${newPayload}, ${actorVals});
		RETURN NEW;
	END IF;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;
		`
	}

	if (pkColumns.length === 1) {
		const pkCol = pkColumns[0]
		// NOTE: PG TEXT cannot contain NUL (chr(0)) — server rejects it at INSERT
		// time with "null character not permitted". So record_id is implicitly
		// NUL-free without explicit stripping in the trigger.
		return `
CREATE OR REPLACE FUNCTION "${schema}"."${funcName}"()
RETURNS TRIGGER AS $$
BEGIN
	IF (TG_OP = 'TRUNCATE') THEN
		-- Statement-level TRUNCATE has no OLD/NEW rows; record a single marker
		-- entry so bulk table wipes are never silently absent from the trail.
		INSERT INTO ${auditTable} (table_name, record_id, operation, ${actorCols})
		VALUES (TG_TABLE_NAME, '(truncate)', 'TRUNCATE', ${actorVals});
		RETURN NULL;
	ELSIF (TG_OP = 'DELETE') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, old_data, ${actorCols})
		VALUES (TG_TABLE_NAME, OLD."${pkCol}"::text, TG_OP, ${oldPayload}, ${actorVals});
		RETURN OLD;
	ELSIF (TG_OP = 'UPDATE') THEN
		IF OLD IS DISTINCT FROM NEW THEN
			INSERT INTO ${auditTable} (table_name, record_id, operation, old_data, new_data, ${actorCols})
			VALUES (TG_TABLE_NAME, NEW."${pkCol}"::text, TG_OP, ${oldPayload}, ${newPayload}, ${actorVals});
		END IF;
		RETURN NEW;
	ELSIF (TG_OP = 'INSERT') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, new_data, ${actorCols})
		VALUES (TG_TABLE_NAME, NEW."${pkCol}"::text, TG_OP, ${newPayload}, ${actorVals});
		RETURN NEW;
	END IF;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;
		`
	}

	// Composite primary key: concatenate with ASCII unit separator (chr(31)) as
	// delimiter. chr(31) is a control character that cannot appear in normal
	// text/varchar PK column values, preventing ambiguous record_id collisions
	// (e.g. PK ('a|b','c') vs ('a','b|c')). COALESCE handles NULL PK parts.
	// PG TEXT cannot hold NUL bytes so no extra stripping is required.
	// Components are NOT truncated: truncating (formerly LEFT(...,200)) let two
	// distinct keys agreeing in their first 200 chars collide onto one record_id.
	// The full values are used so distinct composite keys always map to distinct
	// record_ids. (A pathologically long key may exceed the API's record_id query
	// cap, but it is still stored and correlated correctly — collision safety wins.)
	const pkExpressionsNew = pkColumns
		.map((col) => `COALESCE(NEW."${col}"::text, '')`)
		.join(' || chr(31) || ')
	const pkExpressionsOld = pkColumns
		.map((col) => `COALESCE(OLD."${col}"::text, '')`)
		.join(' || chr(31) || ')

	return `
CREATE OR REPLACE FUNCTION "${schema}"."${funcName}"()
RETURNS TRIGGER AS $$
BEGIN
	IF (TG_OP = 'TRUNCATE') THEN
		-- Statement-level TRUNCATE has no OLD/NEW rows; record a single marker
		-- entry so bulk table wipes are never silently absent from the trail.
		INSERT INTO ${auditTable} (table_name, record_id, operation, ${actorCols})
		VALUES (TG_TABLE_NAME, '(truncate)', 'TRUNCATE', ${actorVals});
		RETURN NULL;
	ELSIF (TG_OP = 'DELETE') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, old_data, ${actorCols})
		VALUES (TG_TABLE_NAME, ${pkExpressionsOld}, TG_OP, ${oldPayload}, ${actorVals});
		RETURN OLD;
	ELSIF (TG_OP = 'UPDATE') THEN
		IF OLD IS DISTINCT FROM NEW THEN
			INSERT INTO ${auditTable} (table_name, record_id, operation, old_data, new_data, ${actorCols})
			VALUES (TG_TABLE_NAME, ${pkExpressionsNew}, TG_OP, ${oldPayload}, ${newPayload}, ${actorVals});
		END IF;
		RETURN NEW;
	ELSIF (TG_OP = 'INSERT') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, new_data, ${actorCols})
		VALUES (TG_TABLE_NAME, ${pkExpressionsNew}, TG_OP, ${newPayload}, ${actorVals});
		RETURN NEW;
	END IF;
END;
$$ LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public;
		`
}
