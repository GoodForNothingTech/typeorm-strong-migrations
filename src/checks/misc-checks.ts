import {
    addEnumValue,
    batchedBackfill,
    createIndexConcurrently,
    dropConstraint,
    rawQuery,
    setNotNull,
} from "../messages/commands"
import { indentBlock } from "../messages/format"
import { quoteIdent, quoteTable } from "../util/sql"
import type { Check } from "./types"
import { unsafe, warn } from "./types"

/** Renaming anything in use breaks the deploy that is still reading the old name. */
export const renameColumnCheck: Check = {
    keys: ["renameColumn"],
    kinds: ["renameColumn"],
    run(op, ctx) {
        if (op.kind !== "renameColumn") return []
        if (ctx.isNewColumn(op.table, op.from)) return []
        return [unsafe("renameColumn")]
    },
}

export const renameTableCheck: Check = {
    keys: ["renameTable"],
    kinds: ["renameTable"],
    run(op, ctx) {
        if (op.kind !== "renameTable") return []
        if (ctx.isNewTable(op.table)) return []
        return [unsafe("renameTable")]
    },
}

export const renameSchemaCheck: Check = {
    keys: ["renameSchema"],
    kinds: ["renameSchema"],
    run(op) {
        return op.kind === "renameSchema" ? [unsafe("renameSchema")] : []
    },
}

export const renameEnumValueCheck: Check = {
    keys: ["renameEnumValue"],
    kinds: ["renameEnumValue"],
    run(op, ctx) {
        if (op.kind !== "renameEnumValue") return []
        return [
            unsafe("renameEnumValue", {
                command: addEnumValue(op.type, op.to, op.from, ctx.render),
            }),
        ]
    },
}

/**
 * An unbounded UPDATE or DELETE holds row locks for the whole statement. The gem
 * documents this hazard but cannot detect it, because in Rails it is buried inside
 * an opaque `execute`; here the analyzer can see the missing WHERE.
 *
 * Deliberately conservative — only a complete absence of WHERE and LIMIT — so the
 * false-positive rate stays at zero.
 */
export const backfillCheck: Check = {
    keys: ["backfill"],
    kinds: ["backfill"],
    run(op, ctx) {
        if (op.kind !== "backfill") return []
        // Same reason as dropTableCheck: a multi-table statement must not be judged
        // by its first table alone.
        return op.tables
            .filter((table) => !ctx.isNewTable(table))
            .map((table) =>
                unsafe("backfill", {
                    tableName: quoteTable(table, ctx.dialect),
                    sql: op.sql,
                    code: indentBlock(batchedBackfill(table), 8),
                }),
            )
    },
}

/**
 * TRUNCATE is unrecoverable and takes an ACCESS EXCLUSIVE lock. On MySQL and
 * MariaDB it also commits implicitly, which ends the migration's transaction
 * mid-flight and leaves earlier statements committed even if a later one fails.
 */
export const truncateCheck: Check = {
    keys: ["truncate"],
    kinds: ["truncate"],
    run(op, ctx) {
        if (op.kind !== "truncate") return []
        const targets = op.tables.filter((table) => !ctx.isNewTable(table))
        if (targets.length === 0) return []
        return targets.map((table) =>
            unsafe("truncate", {
                tableName: quoteTable(table, ctx.dialect),
                command:
                    ctx.render.source === "typed"
                        ? `queryRunner.clearTable(${JSON.stringify(table.name)})`
                        : `queryRunner.query(\`TRUNCATE TABLE ${quoteTable(table, ctx.dialect)}\`)`,
            }),
        )
    },
}

/**
 * Adding a primary key builds a unique index over every row *and* sets the columns
 * NOT NULL, both under an ACCESS EXCLUSIVE lock — the two hazards
 * `createUniqueConstraint` and `changeColumnNull` exist to catch, in one statement.
 *
 * The `USING INDEX` form is already the safe one, so it passes.
 */
export const createPrimaryKeyCheck: Check = {
    keys: ["createPrimaryKey"],
    kinds: ["createPrimaryKey"],
    run(op, ctx) {
        if (op.kind !== "createPrimaryKey") return []
        if (op.usingIndex) return []
        if (ctx.isNewTable(op.table)) return []

        const indexName = `IDX_${[op.table.name, ...op.columns].join("_")}`
        const constraintName = op.name ?? `PK_${op.table.name}`
        const notNull = op.columns
            .map((column) => setNotNull(op.table, column, ctx.render))
            .join("\n        ")

        return [
            unsafe("createPrimaryKey", {
                rewriteBlocks: ctx.adapter.rewriteBlocks,
                notNullCommand: indentBlock(notNull, 8),
                indexCommand: createIndexConcurrently(
                    op.table,
                    op.columns.map((column) => ({ name: column })),
                    { name: indexName, unique: true },
                    ctx.render,
                ),
                constraintCommand: rawQuery(
                    `ALTER TABLE ${quoteTable(op.table, ctx.dialect)} ADD CONSTRAINT ` +
                        `${quoteIdent(constraintName, ctx.dialect)} PRIMARY KEY USING INDEX ` +
                        `${quoteIdent(indexName, ctx.dialect)}`,
                ),
                removeCommand: dropConstraint(
                    op.table,
                    constraintName,
                    ctx.render,
                ),
            }),
        ]
    },
}

/** MySQL's COPY algorithm rebuilds the table and blocks writes throughout. */
export const copyAlgorithmCheck: Check = {
    keys: ["copyAlgorithm"],
    kinds: [
        "addColumn",
        "dropColumn",
        "changeColumn",
        "createIndex",
        "dropIndex",
        "createForeignKey",
    ],
    run(op, ctx) {
        if (ctx.dialect === "postgres") return []
        const options = (op as { mysql?: { algorithm?: string } }).mysql
        if (options?.algorithm !== "COPY") return []
        const table = (op as { table?: { name: string } }).table
        if (
            table &&
            ctx.isNewTable({ ...table, key: table.name.toLowerCase() })
        )
            return []
        return [
            unsafe("copyAlgorithm", {
                command: stripOption(
                    op.raw.sql ?? "",
                    /,?\s*ALGORITHM\s*=?\s*COPY/i,
                ),
            }),
        ]
    },
}

export const lockOptionCheck: Check = {
    keys: ["lockOption"],
    kinds: [
        "addColumn",
        "dropColumn",
        "changeColumn",
        "createIndex",
        "dropIndex",
        "createForeignKey",
    ],
    run(op, ctx) {
        if (ctx.dialect === "postgres") return []
        const lock = (op as { mysql?: { lock?: string } }).mysql?.lock
        if (lock !== "SHARED" && lock !== "EXCLUSIVE") return []
        return [
            unsafe("lockOption", {
                lockType: lock.toLowerCase(),
                lockBlocks: lock === "SHARED" ? "reads" : "reads and writes",
                command: stripOption(
                    op.raw.sql ?? "",
                    /,?\s*LOCK\s*=?\s*(SHARED|EXCLUSIVE)/i,
                ),
            }),
        ]
    },
}

/**
 * DDL the analyzer recognized as schema-changing but could not interpret. This is
 * the honest port of the gem's `execute` check: we genuinely cannot say whether it
 * is safe.
 */
export const rawQueryCheck: Check = {
    keys: ["rawQuery"],
    kinds: ["unknown"],
    run(op, ctx) {
        if (op.kind !== "unknown") return []
        const behavior =
            op.looksLikeDdl || op.reason === "procedural-block"
                ? ctx.config.unknownSql
                : "ignore"
        if (behavior === "ignore") return []
        if (behavior === "warn") {
            return [
                warn(
                    `Could not analyze this statement, continuing anyway: ${op.sql}`,
                ),
            ]
        }
        return [unsafe("rawQuery", { sql: indentBlock(op.sql, 4) })]
    },
}

/**
 * A statement we parsed but whose tail we did not model.
 *
 * Subscribes to every kind either producer can mark `partial`, not just the common
 * ones — `parseAlterTable` back-fills the flag onto whatever it already parsed, so
 * `ALTER TABLE t ADD PRIMARY KEY (a), SET (fillfactor=90)` marks a `createPrimaryKey`
 * that previously had no route to this check.
 */
export const partialParseCheck: Check = {
    keys: ["partialParse"],
    kinds: [
        "addColumn",
        "dropColumn",
        "changeColumn",
        "changeColumnNull",
        "changeColumnDefault",
        "createIndex",
        "dropIndex",
        "createForeignKey",
        "dropForeignKey",
        "createCheckConstraint",
        "createUniqueConstraint",
        "createExclusionConstraint",
        "createPrimaryKey",
        "dropConstraint",
        "validateConstraint",
        "createTable",
        "dropTable",
        "renameTable",
        "renameColumn",
        "truncate",
    ],
    run(op, ctx) {
        if (!op.partial || ctx.config.partialSql === "ignore") return []
        const clauses = (op.unmodeledClauses ?? []).join("; ")
        if (ctx.config.partialSql === "error") {
            return [unsafe("partialParse", { sql: op.raw.sql ?? "", clauses })]
        }
        return [
            warn(
                `Understood part of this statement but not all of it, so some checks may not ` +
                    `have run. Unrecognized: ${clauses}`,
            ),
        ]
    },
}

function stripOption(sql: string, pattern: RegExp): string {
    const cleaned = sql.replace(pattern, "").trim()
    return `await queryRunner.query(\`${cleaned}\`)`
}

export const MISC_CHECKS: Check[] = [
    renameColumnCheck,
    renameTableCheck,
    renameSchemaCheck,
    renameEnumValueCheck,
    backfillCheck,
    truncateCheck,
    createPrimaryKeyCheck,
    copyAlgorithmCheck,
    lockOptionCheck,
    rawQueryCheck,
    partialParseCheck,
]
