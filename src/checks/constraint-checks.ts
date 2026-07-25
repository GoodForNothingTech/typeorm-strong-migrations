import {
    addCheckConstraintNotValid,
    addForeignKeyNotValid,
    addUniqueConstraintUsingIndex,
    createIndexConcurrently,
    dropConstraint,
    removeCheckConstraint,
    removeForeignKey,
    validateConstraint as renderValidate,
} from "../messages/commands"
import { indentBlock } from "../messages/format"
import {
    rewriteCheckConstraintNotValid,
    rewriteForeignKeyNotValid,
} from "../runtime/safe-methods"
import type { Check } from "./types"
import { unsafe } from "./types"

/**
 * Adding a foreign key locks *both* tables while every existing row is validated.
 *
 * Deliberately not exempt for tables created in this migration: the lock lands on
 * the referenced table too, which is almost never new.
 */
export const createForeignKeyCheck: Check = {
    keys: ["createForeignKey", "createForeignKeyMysql"],
    kinds: ["createForeignKey"],
    run(op, ctx) {
        if (op.kind !== "createForeignKey") return []
        if (op.notValid) return []

        const name = op.name ?? `FK_${op.table.name}_${op.columns.join("_")}`

        if (ctx.dialect !== "postgres") {
            return [
                unsafe("createForeignKeyMysql", {
                    addForeignKeyCode: indentBlock(
                        addForeignKeyNotValid(
                            op.table,
                            {
                                name,
                                columns: op.columns,
                                referencedTable: op.referencedTable,
                                referencedColumns: op.referencedColumns,
                            },
                            ctx.render,
                        ).replace(" NOT VALID`", "`"),
                        16,
                    ),
                    removeForeignKeyCode: indentBlock(
                        removeForeignKey(op.table, name, ctx.render),
                        8,
                    ),
                }),
            ]
        }

        if (ctx.config.safeByDefault) {
            const rewrite = rewriteForeignKeyNotValid(op, ctx)
            if (rewrite) return [rewrite]
        }

        return [
            unsafe("createForeignKey", {
                addForeignKeyCode: indentBlock(
                    addForeignKeyNotValid(
                        op.table,
                        {
                            name,
                            columns: op.columns,
                            referencedTable: op.referencedTable,
                            referencedColumns: op.referencedColumns,
                        },
                        ctx.render,
                    ),
                    8,
                ),
                removeForeignKeyCode: indentBlock(
                    removeForeignKey(op.table, name, ctx.render),
                    8,
                ),
                validateForeignKeyCode: indentBlock(
                    renderValidate(op.table, name, ctx.render),
                    8,
                ),
            }),
        ]
    },
}

export const createCheckConstraintCheck: Check = {
    keys: ["createCheckConstraint", "createCheckConstraintMysql"],
    kinds: ["createCheckConstraint"],
    run(op, ctx) {
        if (op.kind !== "createCheckConstraint") return []
        if (op.notValid) return []
        if (ctx.isNewTable(op.table)) return []

        // MySQL and MariaDB have no NOT VALID, so there is no safe rewrite to offer.
        if (ctx.dialect !== "postgres")
            return [unsafe("createCheckConstraintMysql")]

        if (ctx.config.safeByDefault) {
            const rewrite = rewriteCheckConstraintNotValid(op, ctx)
            if (rewrite) return [rewrite]
        }

        const name = op.name ?? `CHK_${op.table.name}`
        return [
            unsafe("createCheckConstraint", {
                addCheckConstraintCode: indentBlock(
                    addCheckConstraintNotValid(
                        op.table,
                        name,
                        op.expression,
                        ctx.render,
                    ),
                    8,
                ),
                removeCheckConstraintCode: indentBlock(
                    removeCheckConstraint(op.table, name, ctx.render),
                    8,
                ),
                validateCheckConstraintCode: indentBlock(
                    renderValidate(op.table, name, ctx.render),
                    8,
                ),
            }),
        ]
    },
}

/**
 * A unique constraint builds a unique index under an exclusive lock. Building the
 * index concurrently first and then adopting it via USING INDEX gets the same
 * result without blocking.
 */
export const createUniqueConstraintCheck: Check = {
    keys: ["createUniqueConstraint"],
    kinds: ["createUniqueConstraint"],
    run(op, ctx) {
        if (op.kind !== "createUniqueConstraint") return []
        // The USING INDEX form is already the safe one.
        if (op.usingIndex) return []
        if (ctx.isNewTable(op.table)) return []
        if (ctx.dialect !== "postgres") return []

        const indexName = `IDX_${[op.table.name, ...op.columns].join("_")}`
        const constraintName =
            op.name ?? `UQ_${[op.table.name, ...op.columns].join("_")}`
        return [
            unsafe("createUniqueConstraint", {
                indexCommand: createIndexConcurrently(
                    op.table,
                    op.columns.map((column) => ({ name: column })),
                    { name: indexName, unique: true },
                    ctx.render,
                ),
                constraintCommand: addUniqueConstraintUsingIndex(
                    op.table,
                    constraintName,
                    indexName,
                    ctx.render,
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

/** Exclusion constraints cannot be added NOT VALID, so there is no safe form. */
export const createExclusionConstraintCheck: Check = {
    keys: ["createExclusionConstraint"],
    kinds: ["createExclusionConstraint"],
    run(op, ctx) {
        if (op.kind !== "createExclusionConstraint") return []
        if (ctx.isNewTable(op.table)) return []
        return [unsafe("createExclusionConstraint")]
    },
}

/**
 * Validating while this session already holds a write-blocking lock — typically
 * because the constraint was added in the same transaction — defeats the whole
 * point of the two-step approach.
 *
 * SQL alone cannot say whether the constraint is a check or a foreign key, so we
 * introspect and fall back to the check-constraint message.
 */
export const validateConstraintCheck: Check = {
    keys: ["validateForeignKey", "validateCheckConstraint"],
    kinds: ["validateConstraint"],
    needsIntrospection: true,
    async run(op, ctx) {
        if (op.kind !== "validateConstraint") return []
        if (ctx.dialect !== "postgres") return []
        if (!ctx.canIntrospect) return []

        const blocked = await ctx.introspect.writesBlocked()
        if (blocked !== true) return []

        const constraint = await ctx.introspect.constraint(op.table, op.name)
        return [
            unsafe(
                constraint?.type === "f"
                    ? "validateForeignKey"
                    : "validateCheckConstraint",
            ),
        ]
    },
}

export const CONSTRAINT_CHECKS: Check[] = [
    createForeignKeyCheck,
    createCheckConstraintCheck,
    createUniqueConstraintCheck,
    createExclusionConstraintCheck,
    validateConstraintCheck,
]
