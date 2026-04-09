/**
 * SQL builder helpers for PgHistory audit triggers.
 *
 * Extracted from PgHistory.ts so the class stays focused on orchestration
 * rather than string templating. All identifiers passed in are assumed to
 * have been validated by the caller (validateIdentifier from validators).
 */

export interface BuildTriggerFunctionArgs {
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
	const { funcName, pkColumns, auditTable } = args

	if (pkColumns.length === 0) {
		// No primary key: use md5 hash of all column values
		return `
CREATE OR REPLACE FUNCTION "${funcName}"()
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
CREATE OR REPLACE FUNCTION "${funcName}"()
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

	// Composite primary key: concatenate with '|' delimiter.
	// COALESCE wraps each column so a NULL PK component doesn't poison the key.
	const pkExpressionsNew = pkColumns
		.map((col) => `COALESCE(NEW."${col}"::text, '')`)
		.join(" || '|' || ")
	const pkExpressionsOld = pkColumns
		.map((col) => `COALESCE(OLD."${col}"::text, '')`)
		.join(" || '|' || ")

	return `
CREATE OR REPLACE FUNCTION "${funcName}"()
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
