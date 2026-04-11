/**
 * SQL builder helpers for PgHistory audit triggers.
 *
 * Extracted from PgHistory.ts so the class stays focused on orchestration
 * rather than string templating. All identifiers passed in are assumed to
 * have been validated by the caller (validateIdentifier from validators).
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
	IF (TG_OP = 'DELETE') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, old_data)
		VALUES (TG_TABLE_NAME, md5(row_to_json(OLD)::text), TG_OP, to_jsonb(OLD));
		RETURN OLD;
	ELSIF (TG_OP = 'UPDATE') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, old_data, new_data)
		VALUES (TG_TABLE_NAME, md5(row_to_json(NEW)::text), TG_OP, to_jsonb(OLD), to_jsonb(NEW));
		RETURN NEW;
	ELSIF (TG_OP = 'INSERT') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, new_data)
		VALUES (TG_TABLE_NAME, md5(row_to_json(NEW)::text), TG_OP, to_jsonb(NEW));
		RETURN NEW;
	END IF;
END;
$$ LANGUAGE plpgsql;
		`
	}

	if (pkColumns.length === 1) {
		const pkCol = pkColumns[0]
		return `
CREATE OR REPLACE FUNCTION "${schema}"."${funcName}"()
RETURNS TRIGGER AS $$
BEGIN
	IF (TG_OP = 'DELETE') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, old_data)
		VALUES (TG_TABLE_NAME, OLD."${pkCol}"::text, TG_OP, to_jsonb(OLD));
		RETURN OLD;
	ELSIF (TG_OP = 'UPDATE') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, old_data, new_data)
		VALUES (TG_TABLE_NAME, NEW."${pkCol}"::text, TG_OP, to_jsonb(OLD), to_jsonb(NEW));
		RETURN NEW;
	ELSIF (TG_OP = 'INSERT') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, new_data)
		VALUES (TG_TABLE_NAME, NEW."${pkCol}"::text, TG_OP, to_jsonb(NEW));
		RETURN NEW;
	END IF;
END;
$$ LANGUAGE plpgsql;
		`
	}

	// Composite primary key: concatenate with ASCII unit separator (chr(31)) as delimiter.
	// chr(31) is a control character that cannot appear in normal text/varchar PK column
	// values, preventing ambiguous record_id collisions (e.g. PK ('a|b','c') vs ('a','b|c')).
	// COALESCE wraps each column so a NULL PK component doesn't poison the key.
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
	IF (TG_OP = 'DELETE') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, old_data)
		VALUES (TG_TABLE_NAME, ${pkExpressionsOld}, TG_OP, to_jsonb(OLD));
		RETURN OLD;
	ELSIF (TG_OP = 'UPDATE') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, old_data, new_data)
		VALUES (TG_TABLE_NAME, ${pkExpressionsNew}, TG_OP, to_jsonb(OLD), to_jsonb(NEW));
		RETURN NEW;
	ELSIF (TG_OP = 'INSERT') THEN
		INSERT INTO ${auditTable} (table_name, record_id, operation, new_data)
		VALUES (TG_TABLE_NAME, ${pkExpressionsNew}, TG_OP, to_jsonb(NEW));
		RETURN NEW;
	END IF;
END;
$$ LANGUAGE plpgsql;
		`
}
