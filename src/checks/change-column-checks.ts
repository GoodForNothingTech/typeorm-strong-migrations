import { notNullConstraintName } from "../adapters/postgres"
import {
    addCheckConstraintNotValid,
    dropConstraint,
    removeCheckConstraint,
    setNotNull,
    validateConstraint as renderValidate,
} from "../messages/commands"
import { indentBlock } from "../messages/format"
import { rewriteSetNotNull } from "../runtime/safe-methods"
import type { Check } from "./types"
import { unsafe } from "./types"

/**
 * Changing a column's type rewrites the table unless the change is one of the
 * narrow widening cases each engine handles in place. The allowlist lives on the
 * adapter, ported from the gem's per-engine matrices.
 */
export const changeColumnCheck: Check = {
    keys: ["changeColumn", "changeColumnWithNotNull", "changeColumnNullMysql"],
    kinds: ["changeColumn"],
    needsIntrospection: true,
    async run(op, ctx) {
        if (op.kind !== "changeColumn") return []
        if (ctx.isNewColumn(op.table, op.column)) return []
        if (!op.newType) return []

        const existing = ctx.canIntrospect
            ? await ctx.introspect.column(op.table, op.column)
            : undefined
        // Without the current type we cannot prove the change is safe, and refusing
        // is the safe direction — the gem's `rescue []` lands in the same place.
        const safe =
            existing?.type !== undefined &&
            (await ctx.adapter.changeTypeSafe(
                {
                    table: op.table,
                    column: op.column,
                    oldType: existing.type,
                    newType: op.newType,
                },
                ctx.introspect,
            ))

        if (!safe) {
            return [
                unsafe("changeColumn", {
                    rewriteBlocks: ctx.adapter.rewriteBlocks,
                }),
            ]
        }

        // The type change is fine, but MySQL's CHANGE/MODIFY carries nullability in
        // the same clause and setting NOT NULL is a separate hazard.
        if (existing?.nullable !== false && op.setNullable === false) {
            // MySQL has no `ALTER COLUMN ... SET NOT NULL`, so this combined form is
            // the only way NOT NULL is ever set there — which makes it the only place
            // the strict-mode rule can apply.
            if (ctx.dialect !== "postgres") {
                const strict = await ctx.adapter.strictMode()
                if (strict === false) return [unsafe("changeColumnNullMysql")]
            }
            return [unsafe("changeColumnWithNotNull")]
        }
        return []
    },
}

/**
 * Postgres re-checks every row against a column's check constraints when the type
 * changes, holding a lock the whole time. Fires even when the type change itself is
 * safe — same as the gem.
 */
export const changeColumnConstraintCheck: Check = {
    keys: ["changeColumnConstraint"],
    kinds: ["changeColumn"],
    needsIntrospection: true,
    async run(op, ctx) {
        if (op.kind !== "changeColumn") return []
        if (ctx.dialect !== "postgres" || !ctx.canIntrospect) return []
        if (ctx.isNewColumn(op.table, op.column)) return []

        const constraints = await ctx.introspect.checkConstraintsOnColumn(
            op.table,
            op.column,
        )
        if (!constraints || constraints.length === 0) return []

        const drops = constraints
            .map((constraint) =>
                dropConstraint(op.table, constraint.name, ctx.render),
            )
            .join("\n        ")
        const readds = constraints
            .map((constraint) => {
                const expression = constraint.definition
                    .replace(/^CHECK\s*/i, "")
                    .trim()
                return addCheckConstraintNotValid(
                    op.table,
                    constraint.name,
                    stripOuterParens(expression),
                    ctx.render,
                )
            })
            .join("\n        ")
        const validates = constraints
            .map((constraint) =>
                renderValidate(op.table, constraint.name, ctx.render),
            )
            .join("\n        ")

        return [
            unsafe("changeColumnConstraint", {
                changeColumnCode: indentBlock(`${drops}\n${readds}`, 8),
                validateConstraintCode: indentBlock(validates, 8),
            }),
        ]
    },
}

/**
 * SET NOT NULL scans every row while holding an ACCESS EXCLUSIVE lock. The safe
 * path proves the invariant with a NOT VALID check constraint first, after which
 * Postgres can flip the flag without a scan.
 */
export const changeColumnNullCheck: Check = {
    keys: ["changeColumnNullPostgres", "changeColumnNullMysql"],
    kinds: ["changeColumnNull"],
    needsIntrospection: true,
    async run(op, ctx) {
        if (op.kind !== "changeColumnNull") return []
        if (op.nullable) return []
        if (ctx.isNewColumn(op.table, op.column)) return []

        if (ctx.dialect !== "postgres") {
            // MySQL only enforces NOT NULL under strict mode; without it, existing
            // NULLs are silently coerced instead of raising.
            const strict = await ctx.adapter.strictMode()
            return strict === true ? [] : [unsafe("changeColumnNullMysql")]
        }

        // An already-validated `col IS NOT NULL` constraint makes SET NOT NULL cheap.
        if (ctx.canIntrospect) {
            const constraints = await ctx.introspect.checkConstraintsOnColumn(
                op.table,
                op.column,
            )
            const proven = constraints?.some(
                (constraint) =>
                    constraint.validated &&
                    /IS\s+NOT\s+NULL/i.test(constraint.definition) &&
                    constraint.definition.includes(op.column),
            )
            if (proven) return []
        }

        if (ctx.config.safeByDefault) {
            const rewrite = rewriteSetNotNull(op, ctx)
            if (rewrite) return [rewrite]
        }

        const name = notNullConstraintName(
            op.table,
            op.column,
            ctx.adapter.maxConstraintNameLength,
        )
        const expression = `${quoted(op.column)} IS NOT NULL`
        return [
            unsafe("changeColumnNullPostgres", {
                addConstraintCode: indentBlock(
                    addCheckConstraintNotValid(
                        op.table,
                        name,
                        expression,
                        ctx.render,
                    ),
                    8,
                ),
                removeConstraintCode: indentBlock(
                    removeCheckConstraint(op.table, name, ctx.render),
                    8,
                ),
                validateConstraintCode: indentBlock(
                    [
                        renderValidate(op.table, name, ctx.render),
                        setNotNull(op.table, op.column, ctx.render),
                        removeCheckConstraint(op.table, name, ctx.render),
                    ].join("\n"),
                    8,
                ),
            }),
        ]
    },
}

/**
 * Rails' version of this check guards `partial_inserts`, which TypeORM has no
 * equivalent of — it always writes an explicit column list. What remains is schema
 * drift, so the key ships disabled and reads as a best practice rather than a
 * hazard.
 */
export const changeColumnDefaultCheck: Check = {
    keys: ["changeColumnDefault"],
    kinds: ["changeColumnDefault"],
    run(op, ctx) {
        if (op.kind !== "changeColumnDefault") return []
        if (ctx.isNewColumn(op.table, op.column)) return []
        const mapping = ctx.entityProperty(op.table, op.column)
        if (!mapping) return []
        return [
            unsafe("changeColumnDefault", {
                entity: mapping.entity,
                property: `${mapping.property}!: unknown`,
                // The parsed default is SQL text, and it is being rendered into a
                // TypeScript decorator, so it has to be quoted to be valid there.
                default: renderDefaultForDecorator(op.newDefault?.raw),
            }),
        ]
    },
}

function quoted(column: string): string {
    return `"${column.replaceAll('"', '""')}"`
}

/** SQL default text as a TypeScript value for `@Column({ default: ... })`. */
function renderDefaultForDecorator(raw: string | undefined): string {
    if (raw === undefined) return "null"
    const trimmed = raw.trim()
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) return trimmed
    if (/^(true|false|null)$/i.test(trimmed)) return trimmed.toLowerCase()
    // A SQL string literal becomes a JS string; an expression stays SQL text, which
    // TypeORM also accepts as a string.
    const unquoted = /^'((?:[^']|'')*)'$/.exec(trimmed)
    return JSON.stringify(
        unquoted ? unquoted[1]!.replaceAll("''", "'") : trimmed,
    )
}

function stripOuterParens(text: string): string {
    const trimmed = text.trim()
    return /^\(.*\)$/s.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed
}

export const CHANGE_COLUMN_CHECKS: Check[] = [
    changeColumnCheck,
    changeColumnConstraintCheck,
    changeColumnNullCheck,
    changeColumnDefaultCheck,
]
