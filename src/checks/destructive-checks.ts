import { batchedBackfill } from "../messages/commands"
import { indentBlock } from "../messages/format"
import { jsString, quoteTable } from "../util/sql"
import type { Check } from "./types"
import { unsafe } from "./types"

/**
 * Operations that reached none of the three interception paths before, plus the ones
 * the classifier used to call `benign` — which meant they were filtered out before any
 * check could see them.
 *
 * None of these has a counterpart in strong_migrations: Rails migrations have no
 * `clearDatabase`, and the gem's `execute` catch-all meant it never had to classify
 * raw statements at all.
 */

/** Drops every table and view. The single most destructive thing a QueryRunner can do. */
export const clearDatabaseCheck: Check = {
    keys: ["clearDatabase"],
    kinds: ["clearDatabase"],
    run(op) {
        if (op.kind !== "clearDatabase") return []
        return [
            unsafe("clearDatabase", {
                database: op.database ? `"${op.database}"` : "this database",
            }),
        ]
    },
}

export const dropSchemaCheck: Check = {
    keys: ["dropSchema"],
    kinds: ["dropSchema"],
    run(op) {
        if (op.kind !== "dropSchema") return []
        return [
            unsafe("dropSchema", {
                schema: jsString(op.schema),
                cascade: op.cascade
                    ? "CASCADE means it also drops everything that depends on them. "
                    : "",
            }),
        ]
    },
}

export const dropDatabaseCheck: Check = {
    keys: ["dropDatabase"],
    kinds: ["dropDatabase"],
    run(op) {
        return op.kind === "dropDatabase" ? [unsafe("dropDatabase")] : []
    },
}

/** Breaks every query reading the view, exactly as dropping a table would. */
export const dropViewCheck: Check = {
    keys: ["dropView"],
    kinds: ["dropView"],
    run(op, ctx) {
        if (op.kind !== "dropView") return []
        return op.views
            .filter((view) => !ctx.isNewTable(view))
            .map((view) =>
                unsafe("dropView", { viewName: jsString(view.name) }),
            )
    },
}

/**
 * A full table rebuild expressed as a table option — MySQL `ENGINE=`, `FORCE`,
 * `CONVERT TO CHARACTER SET`; Postgres `SET LOGGED`, `SET TABLESPACE`.
 */
export const tableRewriteCheck: Check = {
    keys: ["tableRewrite"],
    kinds: ["tableRewrite"],
    run(op, ctx) {
        if (op.kind !== "tableRewrite") return []
        if (ctx.isNewTable(op.table)) return []
        // CONVERT TO CHARACTER SET also silently retypes every string column, which is
        // a second hazard on top of the rebuild.
        const append = /convert/i.test(op.clause)
            ? "\n\nIt also changes the declared type of every string column, because the byte" +
              "\nwidth of a character changes with the charset."
            : ""
        return [
            unsafe("tableRewrite", {
                clause: op.clause,
                tableName: quoteTable(op.table, ctx.dialect),
                rewriteBlocks: ctx.adapter.rewriteBlocks,
                append,
            }),
        ]
    },
}

export const vacuumFullCheck: Check = {
    keys: ["vacuumFull"],
    kinds: ["vacuumFull"],
    run(op, ctx) {
        if (op.kind !== "vacuumFull") return []
        const target = op.tables[0]
        return [
            unsafe("vacuumFull", {
                tableName: target
                    ? quoteTable(target, ctx.dialect)
                    : "every table",
            }),
        ]
    },
}

/** Postgres implements foreign keys as triggers, so this disables enforcement. */
export const disableTriggerCheck: Check = {
    keys: ["disableTrigger"],
    kinds: ["disableTrigger"],
    run(op, ctx) {
        if (op.kind !== "disableTrigger") return []
        if (ctx.isNewTable(op.table)) return []
        return [
            unsafe("disableTrigger", {
                tableName: quoteTable(op.table, ctx.dialect),
            }),
        ]
    },
}

export const flushTablesCheck: Check = {
    keys: ["flushTables"],
    kinds: ["flushTables"],
    run(op) {
        return op.kind === "flushTables" && op.withReadLock
            ? [unsafe("flushTables")]
            : []
    },
}

/** The write-everything sibling of `backfill`, which only covered UPDATE and DELETE. */
export const insertSelectCheck: Check = {
    keys: ["insertSelect"],
    kinds: ["insertSelect"],
    run(op, ctx) {
        if (op.kind !== "insertSelect") return []
        const target = op.tables[0]
        // Populating a table this migration just created harms nobody.
        if (target && ctx.isNewTable(target)) return []
        return [
            unsafe("insertSelect", {
                sql: op.sql,
                code: target
                    ? indentBlock(batchedBackfill(target), 8)
                    : "        // copy in batches",
            }),
        ]
    },
}

export const DESTRUCTIVE_CHECKS: Check[] = [
    clearDatabaseCheck,
    dropSchemaCheck,
    dropDatabaseCheck,
    dropViewCheck,
    tableRewriteCheck,
    vacuumFullCheck,
    disableTriggerCheck,
    flushTablesCheck,
    insertSelectCheck,
]
