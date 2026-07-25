import type { Operation } from "../operations/types"
import { operationTables } from "../operations/types"

export interface BookkeepingConfig {
    migrationsTableName: string
    metadataTableName: string
    migrationsSchema?: string
    extraTables?: string[]
}

export function bookkeepingConfig(options: {
    migrationsTableName?: string
    metadataTableName?: string
    schema?: string
}): BookkeepingConfig {
    return {
        migrationsTableName: options.migrationsTableName ?? "migrations",
        metadataTableName: options.metadataTableName ?? "typeorm_metadata",
        migrationsSchema: options.schema,
    }
}

/**
 * TypeORM's own bookkeeping must never be flagged. It creates the migrations table
 * on first run and writes a row per migration; a linter that complained about that
 * would fire on literally every project's first migration.
 *
 * This is deliberately not configurable off — suppressing it is always correct.
 */
export function isBookkeeping(
    op: Operation,
    config: BookkeepingConfig,
): boolean {
    const names = new Set(
        [
            config.migrationsTableName,
            config.metadataTableName,
            ...(config.extraTables ?? []),
        ].map((name) => name.toLowerCase()),
    )
    const tables = operationTables(op)
    if (tables.length === 0) return false
    return tables.every((table) => names.has(table.name.toLowerCase()))
}

const SYSTEM_SCHEMAS =
    /\b(information_schema|pg_catalog|pg_class|pg_index|pg_constraint|pg_locks|pg_proc|pg_namespace|pg_type|pg_attribute)\b/i

/** Catalog reads and session setup, ours or TypeORM's. */
export function isInfrastructureSql(sql: string): boolean {
    const trimmed = sql.trim()
    // Only when the statement *is* a catalog read. Testing the whole body meant any
    // statement that merely mentioned a catalog was exempted — including the standard
    // `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns ...) THEN
    // ALTER TABLE ... DROP COLUMN ... END $$` idiom, whose DDL then went unchecked.
    if (
        /^\s*(SELECT|SHOW|WITH)\b/i.test(trimmed) &&
        SYSTEM_SCHEMAS.test(trimmed)
    )
        return true
    if (
        /^\s*(SAVEPOINT|RELEASE\s+SAVEPOINT|ROLLBACK\s+TO\s+SAVEPOINT)\s+typeorm/i.test(
            trimmed,
        )
    ) {
        return true
    }
    if (
        /^\s*SET\s+(SESSION\s+)?(statement_timeout|lock_timeout|transaction_timeout|max_execution_time|max_statement_time|lock_wait_timeout)\b/i.test(
            trimmed,
        )
    ) {
        return true
    }
    if (
        /^\s*SELECT\s+(version|current_schema|current_database)\s*\(/i.test(
            trimmed,
        )
    )
        return true
    return false
}

export type StatementClass =
    | "ddl-parsed"
    | "ddl-unparsed"
    | "backfill"
    | "benign"
    | "bookkeeping"
    | "unparseable"

export function classify(
    op: Operation,
    config: BookkeepingConfig,
): StatementClass {
    if (op.kind === "benign") {
        return isInfrastructureSql(op.sql) ? "bookkeeping" : "benign"
    }
    if (isBookkeeping(op, config)) return "bookkeeping"
    if (op.kind === "backfill") return "backfill"
    if (op.kind === "unknown") {
        if (isInfrastructureSql(op.sql)) return "bookkeeping"
        return op.looksLikeDdl || op.reason === "procedural-block"
            ? "ddl-unparsed"
            : "unparseable"
    }
    return "ddl-parsed"
}
