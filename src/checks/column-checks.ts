import {
    addColumnWithoutDefault,
    batchedBackfill,
    changeColumnDefault as renderChangeDefault,
    dropColumn as renderDropColumn,
    dropTable as renderDropTable,
} from "../messages/commands"
import { indentBlock } from "../messages/format"
import { guessEntityName } from "../util/sql"
import type { Check } from "./types"
import { unsafe } from "./types"

/**
 * Adding a column with a volatile default rewrites the whole table.
 *
 * Both supported engines write a fast default (Postgres 11+, MySQL 8.0.12+), so
 * unlike the gem's broader wording this only fires in the one case that still
 * rewrites: a Postgres uuid column defaulted to a volatile function. Generalizing
 * it would flag `DEFAULT now()` on every timestamp column, which is safe and
 * ubiquitous — the gem deliberately does not flag that either.
 */
export const addColumnDefaultCheck: Check = {
    keys: ["addColumnDefault"],
    kinds: ["addColumn"],
    needsIntrospection: true,
    async run(op, ctx) {
        if (op.kind !== "addColumn") return []
        const { column } = op
        const value = column.default
        if (!value || value.kind === "null") return []
        if (ctx.isNewTable(op.table)) return []

        const rewritesTable = !ctx.adapter.addColumnDefaultSafe
        let volatile = false
        if (
            ctx.dialect === "postgres" &&
            column.type?.baseType === "uuid" &&
            value.containsCall &&
            value.functionName
        ) {
            volatile = ctx.canIntrospect
                ? await ctx.introspect.isVolatileFunction(
                      value.functionName,
                      value.functionSchema,
                  )
                : true
        }
        if (!rewritesTable && !volatile) return []

        const withoutDefault = { ...column, nullable: true }
        return [
            unsafe("addColumnDefault", {
                defaultType: volatile ? "volatile" : "non-null",
                rewriteBlocks: ctx.adapter.rewriteBlocks,
                addCommand: addColumnWithoutDefault(
                    op.table,
                    withoutDefault,
                    ctx.render,
                ),
                changeCommand: renderChangeDefault(
                    op.table,
                    column,
                    ctx.render,
                ),
                removeCommand: renderDropColumn(
                    op.table,
                    [column.name],
                    ctx.render,
                ).replace(/^queryRunner\./, "await queryRunner."),
                code: indentBlock(batchedBackfill(op.table), 8),
            }),
        ]
    },
}

/**
 * `TableColumn.default` is raw SQL, so an expression default cannot always be
 * resolved to a known function. This is the honest TypeORM reframing of the gem's
 * callable-default check.
 */
export const addColumnDefaultExpressionCheck: Check = {
    keys: ["addColumnDefaultExpression"],
    kinds: ["addColumn"],
    run(op, ctx) {
        if (op.kind !== "addColumn") return []
        const value = op.column.default
        if (!value) return []
        if (ctx.isNewTable(op.table)) return []
        // Only the genuinely opaque forms: a JS function, or an expression with a
        // call we could not name.
        const opaque =
            value.kind === "callable" ||
            (value.kind === "expression" &&
                value.containsCall &&
                !value.functionName)
        if (!opaque) return []

        return [
            unsafe("addColumnDefaultExpression", {
                default: value.raw,
                addCommand: addColumnWithoutDefault(
                    op.table,
                    { ...op.column, nullable: true },
                    ctx.render,
                ),
                changeCommand: renderChangeDefault(
                    op.table,
                    op.column,
                    ctx.render,
                ),
                removeCommand: renderDropColumn(
                    op.table,
                    [op.column.name],
                    ctx.render,
                ).replace(/^queryRunner\./, "await queryRunner."),
            }),
        ]
    },
}

/** json has no equality operator, so SELECT DISTINCT breaks against it. */
export const addColumnJsonCheck: Check = {
    keys: ["addColumnJson"],
    kinds: ["addColumn"],
    run(op, ctx) {
        if (op.kind !== "addColumn") return []
        if (ctx.dialect !== "postgres") return []
        if (op.column.type?.baseType !== "json") return []

        const jsonb = {
            ...op.column,
            type: op.column.type
                ? { ...op.column.type, baseType: "jsonb", raw: "jsonb" }
                : undefined,
        }
        return [
            unsafe("addColumnJson", {
                command: addColumnWithoutDefault(op.table, jsonb, ctx.render),
            }),
        ]
    },
}

/** A stored generated column has to be materialized for every existing row. */
export const addColumnGeneratedStoredCheck: Check = {
    keys: ["addColumnGeneratedStored"],
    kinds: ["addColumn"],
    run(op, ctx) {
        if (op.kind !== "addColumn") return []
        if (op.column.generated?.storage !== "STORED") return []
        if (ctx.isNewTable(op.table)) return []
        return [
            unsafe("addColumnGeneratedStored", {
                rewriteBlocks: ctx.adapter.rewriteBlocks,
            }),
        ]
    },
}

export const addColumnAutoIncrementingCheck: Check = {
    keys: ["addColumnAutoIncrementing"],
    kinds: ["addColumn"],
    run(op, ctx) {
        if (op.kind !== "addColumn") return []
        if (!op.column.autoIncrement) return []
        if (ctx.isNewTable(op.table)) return []
        return [
            unsafe("addColumnAutoIncrementing", {
                rewriteBlocks: ctx.adapter.rewriteBlocks,
                append:
                    ctx.dialect === "postgres"
                        ? ""
                        : "\n\nIf using statement-based replication, this can also generate different values on replicas.",
            }),
        ]
    },
}

/**
 * TypeORM builds explicit SELECT column lists from entity metadata, so a running
 * deploy whose entity still declares the column gets a hard `42703 column does not
 * exist` on every query for that entity — worse than the Rails attribute-cache
 * problem this check exists for.
 */
export const dropColumnCheck: Check = {
    keys: ["dropColumn"],
    kinds: ["dropColumn"],
    run(op, ctx) {
        if (op.kind !== "dropColumn") return []
        if (ctx.isNewTable(op.table)) return []

        const mapping = op.columns
            .map((column) => ctx.entityProperty(op.table, column))
            .find((found) => found !== undefined)
        const entity =
            mapping?.entity ??
            ctx.entityName(op.table) ??
            guessEntityName(op.table.name)
        const code = mapping
            ? `@Column()\n    ${mapping.property}: unknown`
            : `// the property mapped to ${op.columns.map((column) => JSON.stringify(column)).join(", ")}`

        return [
            unsafe("dropColumn", {
                columns: op.columns.map((column) => `"${column}"`).join(", "),
                entity,
                code: indentBlock(code, 4),
                command: renderDropColumn(op.table, op.columns, ctx.render),
            }),
        ]
    },
}

/**
 * The gem has no drop_table check at all. TypeORM does have a typed `dropTable`,
 * and the hazard — unrecoverable data loss plus every running query against a
 * missing table — is the same one `create_table force:` guards in Rails.
 */
export const dropTableCheck: Check = {
    keys: ["dropTable"],
    kinds: ["dropTable"],
    run(op, ctx) {
        if (op.kind !== "dropTable") return []
        // Every table, not just `tables[0]`: `DROP TABLE tmp_new, users` is one
        // statement, and keying the whole verdict off the first name meant a table
        // created earlier in the migration exempted the production tables listed
        // after it — and, even without that, only the first was ever named.
        return op.tables
            .filter((target) => !ctx.isNewTable(target))
            .map((target) =>
                unsafe("dropTable", {
                    entity:
                        ctx.entityName(target) ?? guessEntityName(target.name),
                    command: renderDropTable(target, ctx.render),
                }),
            )
    },
}

export const COLUMN_CHECKS: Check[] = [
    addColumnDefaultCheck,
    addColumnDefaultExpressionCheck,
    addColumnJsonCheck,
    addColumnGeneratedStoredCheck,
    addColumnAutoIncrementingCheck,
    dropColumnCheck,
    dropTableCheck,
]
