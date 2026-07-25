import { is } from "../compat/typeorm"
import { parseSqlType, serialImpliedType } from "../sql/types"
import type {
    ColumnSpec,
    DefaultValue,
    Dialect,
    IndexColumn,
    Operation,
    OperationBase,
    TableRef,
} from "./types"
import { tableRef } from "./types"

/**
 * Normalizes a typed QueryRunner DDL call into the same `Operation` values the SQL
 * analyzer produces, so every check is written once and fires on both paths.
 */

type Args = readonly unknown[]

function base(method: string, args: Args): OperationBase {
    return { source: "typed", raw: { method, args } }
}

export function parseTablePath(path: string): TableRef {
    const parts = path.split(".")
    if (parts.length === 1) return tableRef(parts[0]!)
    // TypeORM allows database.schema.table; the last two are what we care about.
    return tableRef(parts[parts.length - 1]!, parts[parts.length - 2]!)
}

function toTableRef(value: unknown): TableRef {
    if (typeof value === "string") return parseTablePath(value)
    if (is.table(value)) {
        const table = value as { name: string; schema?: string }
        // Table.name may itself be qualified.
        const parsed = parseTablePath(table.name)
        return table.schema ? tableRef(parsed.name, table.schema) : parsed
    }
    const name = (value as { name?: string } | undefined)?.name
    return tableRef(name ?? "?")
}

function columnName(value: unknown): string {
    if (typeof value === "string") return value
    return String((value as { name?: string } | undefined)?.name ?? "?")
}

/**
 * `TableColumn.default` is a raw SQL fragment, not a value — TypeORM inlines it
 * verbatim. So classification is textual, exactly as it is for parsed SQL.
 */
export function normalizeDefault(value: unknown): DefaultValue | undefined {
    if (value === undefined) return undefined
    if (value === null)
        return { kind: "null", raw: "NULL", containsCall: false }
    if (typeof value === "function") {
        return { kind: "callable", raw: "<function>", containsCall: true }
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return {
            kind: "literal",
            raw: String(value),
            containsCall: false,
            literal: value,
        }
    }
    const raw = String(value)
    const trimmed = raw.trim()
    if (/^'(?:[^']|'')*'$/.test(trimmed)) {
        return {
            kind: "literal",
            raw,
            containsCall: false,
            literal: trimmed.slice(1, -1).replaceAll("''", "'"),
        }
    }
    if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
        return {
            kind: "literal",
            raw,
            containsCall: false,
            literal: Number(trimmed),
        }
    }
    if (/^(true|false|null)$/i.test(trimmed)) {
        return { kind: "literal", raw, containsCall: false }
    }
    const call =
        /^(?:"?([A-Za-z_][\w]*)"?\s*\.\s*)?"?([A-Za-z_][\w]*)"?\s*\(\s*\)?/.exec(
            trimmed,
        )
    if (call && trimmed.includes("(")) {
        const name = call[2]!.toLowerCase()
        return {
            kind: name === "nextval" ? "sequence" : "functionCall",
            raw,
            functionName: name,
            functionSchema: call[1]?.toLowerCase(),
            containsCall: true,
        }
    }
    if (
        /^(CURRENT_TIMESTAMP|CURRENT_DATE|CURRENT_TIME|LOCALTIME|LOCALTIMESTAMP)$/i.test(
            trimmed,
        )
    ) {
        return {
            kind: "keyword",
            raw,
            functionName: trimmed.toLowerCase(),
            containsCall: false,
        }
    }
    return { kind: "expression", raw, containsCall: trimmed.includes("(") }
}

export function normalizeColumn(value: unknown, dialect: Dialect): ColumnSpec {
    const column = value as {
        name: string
        type: string
        length?: string
        precision?: number | null
        scale?: number
        isNullable?: boolean
        isPrimary?: boolean
        isUnique?: boolean
        isArray?: boolean
        isGenerated?: boolean
        generationStrategy?: string
        generatedIdentity?: "ALWAYS" | "BY DEFAULT"
        generatedType?: "VIRTUAL" | "STORED"
        asExpression?: string
        default?: unknown
        enum?: string[]
        comment?: string
        onUpdate?: string
    }

    let typeText = column.type ?? "text"
    if (column.length) typeText += `(${column.length})`
    else if (column.precision !== undefined && column.precision !== null) {
        typeText +=
            column.scale === undefined
                ? `(${column.precision})`
                : `(${column.precision},${column.scale})`
    }
    if (column.isArray) typeText += "[]"

    const type = parseSqlType(typeText, dialect)
    if (column.enum) type.enumValues = column.enum

    // SERIAL is sugar for integer + a sequence; record the hazard, normalize the type.
    const implied = serialImpliedType(column.type ?? "")
    let autoIncrement: ColumnSpec["autoIncrement"]
    if (implied) {
        type.baseType = implied
        autoIncrement = { style: "serial" }
    } else if (column.generatedIdentity) {
        autoIncrement = {
            style: "identity",
            identityMode: column.generatedIdentity,
        }
    } else if (
        column.isGenerated &&
        column.generationStrategy === "increment"
    ) {
        autoIncrement = {
            style: dialect === "postgres" ? "serial" : "autoIncrement",
        }
    }

    return {
        name: column.name,
        type,
        nullable: column.isNullable,
        default: normalizeDefault(column.default),
        autoIncrement,
        generated: column.asExpression
            ? {
                  expression: column.asExpression,
                  storage:
                      column.generatedType === "STORED" ? "STORED" : "VIRTUAL",
              }
            : undefined,
        isPrimaryKey: column.isPrimary,
        isUnique: column.isUnique,
        comment: column.comment,
        onUpdate: column.onUpdate,
    }
}

function normalizeIndexColumns(names: unknown): IndexColumn[] {
    if (!Array.isArray(names)) return []
    return names.map((name) => ({ name: String(name) }))
}

/**
 * Maps a QueryRunner method call to zero or more operations. Batch methods
 * (`addColumns`, `createIndices`, ...) fan out through the same path as their
 * singular forms, so no check needs to know the difference.
 */
export function operationsFromTypedCall(
    method: string,
    args: Args,
    dialect: Dialect,
): Operation[] | undefined {
    const meta = base(method, args)

    switch (method) {
        case "createTable": {
            const table = args[0] as { columns?: unknown[] } | undefined
            return [
                {
                    ...meta,
                    kind: "createTable",
                    table: toTableRef(args[0]),
                    columns: (table?.columns ?? []).map((column) =>
                        normalizeColumn(column, dialect),
                    ),
                    ifNotExists: Boolean(args[1]),
                },
            ]
        }

        case "dropTable":
            return [
                {
                    ...meta,
                    kind: "dropTable",
                    tables: [toTableRef(args[0])],
                    ifExists: Boolean(args[1]),
                },
            ]

        case "renameTable":
            return [
                {
                    ...meta,
                    kind: "renameTable",
                    table: toTableRef(args[0]),
                    newName: String(args[1]),
                },
            ]

        case "addColumn":
            return [
                {
                    ...meta,
                    kind: "addColumn",
                    table: toTableRef(args[0]),
                    column: normalizeColumn(args[1], dialect),
                },
            ]

        case "addColumns": {
            const columns = (args[1] as unknown[]) ?? []
            const table = toTableRef(args[0])
            return columns.map((column) => ({
                ...meta,
                kind: "addColumn" as const,
                table,
                column: normalizeColumn(column, dialect),
            }))
        }

        case "dropColumn":
            return [
                {
                    ...meta,
                    kind: "dropColumn",
                    table: toTableRef(args[0]),
                    columns: [columnName(args[1])],
                },
            ]

        case "dropColumns": {
            const columns = (args[1] as unknown[]) ?? []
            return [
                {
                    ...meta,
                    kind: "dropColumn",
                    table: toTableRef(args[0]),
                    columns: columns.map(columnName),
                },
            ]
        }

        case "renameColumn":
            return [
                {
                    ...meta,
                    kind: "renameColumn",
                    table: toTableRef(args[0]),
                    from: columnName(args[1]),
                    to: columnName(args[2]),
                },
            ]

        case "changeColumn":
            return [
                changeColumnOperation(meta, args[0], args[1], args[2], dialect),
            ]

        case "changeColumns": {
            const changes =
                (args[1] as Array<{
                    oldColumn: unknown
                    newColumn: unknown
                }>) ?? []
            return changes.map((change) =>
                changeColumnOperation(
                    meta,
                    args[0],
                    change.oldColumn,
                    change.newColumn,
                    dialect,
                ),
            )
        }

        case "createIndex":
            return [indexOperation(meta, args[0], args[1])]

        case "createIndices": {
            const indices = (args[1] as unknown[]) ?? []
            return indices.map((index) => indexOperation(meta, args[0], index))
        }

        case "dropIndex":
            return [dropIndexOperation(meta, args[0], args[1])]

        case "dropIndices": {
            const indices = (args[1] as unknown[]) ?? []
            return indices.map((index) =>
                dropIndexOperation(meta, args[0], index),
            )
        }

        case "createForeignKey":
            return [foreignKeyOperation(meta, args[0], args[1])]

        case "createForeignKeys": {
            const keys = (args[1] as unknown[]) ?? []
            return keys.map((key) => foreignKeyOperation(meta, args[0], key))
        }

        case "dropForeignKey":
            return [
                {
                    ...meta,
                    kind: "dropForeignKey",
                    table: toTableRef(args[0]),
                    name: constraintName(args[1]),
                },
            ]

        // TypeORM implements this as a loop over `this.dropForeignKey`, but `this` is
        // the unwrapped runner, so without its own case the plural form bypassed
        // interception entirely — unlike every other plural DDL method here.
        case "dropForeignKeys": {
            const keys = (args[1] as unknown[]) ?? []
            return keys.map((key) => ({
                ...meta,
                kind: "dropForeignKey" as const,
                table: toTableRef(args[0]),
                name: constraintName(key),
            }))
        }

        case "createCheckConstraint":
            return [checkConstraintOperation(meta, args[0], args[1])]

        case "createCheckConstraints": {
            const constraints = (args[1] as unknown[]) ?? []
            return constraints.map((constraint) =>
                checkConstraintOperation(meta, args[0], constraint),
            )
        }

        case "createUniqueConstraint":
            return [uniqueConstraintOperation(meta, args[0], args[1])]

        case "createUniqueConstraints": {
            const constraints = (args[1] as unknown[]) ?? []
            return constraints.map((constraint) =>
                uniqueConstraintOperation(meta, args[0], constraint),
            )
        }

        case "createExclusionConstraint":
            return [exclusionConstraintOperation(meta, args[0], args[1])]

        case "createExclusionConstraints": {
            const constraints = (args[1] as unknown[]) ?? []
            return constraints.map((constraint) =>
                exclusionConstraintOperation(meta, args[0], constraint),
            )
        }

        case "createPrimaryKey":
            return [
                {
                    ...meta,
                    kind: "createPrimaryKey",
                    table: toTableRef(args[0]),
                    columns: ((args[1] as string[]) ?? []).map(String),
                    name: args[2] === undefined ? undefined : String(args[2]),
                },
            ]

        case "clearTable":
            return [
                { ...meta, kind: "truncate", tables: [toTableRef(args[0])] },
            ]

        // ── destructive operations that previously reached no interception path ──

        case "clearDatabase":
            return [
                {
                    ...meta,
                    kind: "clearDatabase",
                    database:
                        args[0] === undefined ? undefined : String(args[0]),
                },
            ]

        case "dropSchema":
            return [
                {
                    ...meta,
                    kind: "dropSchema",
                    schema: String(args[0] ?? "?"),
                    cascade: Boolean(args[2]),
                },
            ]

        case "dropDatabase":
            return [
                {
                    ...meta,
                    kind: "dropDatabase",
                    database: String(args[0] ?? "?"),
                },
            ]

        case "dropView":
            return [{ ...meta, kind: "dropView", views: [toTableRef(args[0])] }]

        case "dropPrimaryKey":
            return [
                {
                    ...meta,
                    kind: "dropConstraint",
                    table: toTableRef(args[0]),
                    name: args[1] === undefined ? "PRIMARY" : String(args[1]),
                },
            ]

        /**
         * Replaces the primary key wholesale — the same build-a-unique-index-and-set-
         * NOT-NULL hazard as adding one, so it maps onto `createPrimaryKey`.
         */
        case "updatePrimaryKeys": {
            const columns = (args[1] as Array<{ name?: string }>) ?? []
            return [
                {
                    ...meta,
                    kind: "createPrimaryKey",
                    table: toTableRef(args[0]),
                    columns: columns.map((column) =>
                        String(column?.name ?? "?"),
                    ),
                },
            ]
        }

        // Dropping a constraint is a fast metadata change on both engines; these are
        // modelled so they are *seen*, not because they are hazards.
        case "dropUniqueConstraint":
        case "dropCheckConstraint":
        case "dropExclusionConstraint":
            return [
                {
                    ...meta,
                    kind: "dropConstraint",
                    table: toTableRef(args[0]),
                    name: constraintName(args[1]),
                },
            ]

        case "dropUniqueConstraints":
        case "dropCheckConstraints":
        case "dropExclusionConstraints": {
            // TypeORM loops over the singular form using the unwrapped runner, so the
            // inner calls are invisible and the plural form needs its own case.
            const constraints = (args[1] as unknown[]) ?? []
            const table = toTableRef(args[0])
            return constraints.map((constraint) => ({
                ...meta,
                kind: "dropConstraint" as const,
                table,
                name: constraintName(constraint),
            }))
        }

        // Recognized so the exhaustiveness guard passes, and so timeouts still apply.
        // None of these lock an existing table.
        case "createSchema":
        case "createDatabase":
        case "createView":
        case "changeTableComment":
            return [{ ...meta, kind: "benign", sql: method }]

        default:
            // Not a schema-mutating method we model — pass straight through.
            return undefined
    }
}

function changeColumnOperation(
    meta: OperationBase,
    tableArg: unknown,
    oldColumn: unknown,
    newColumn: unknown,
    dialect: Dialect,
): Operation {
    const next = normalizeColumn(newColumn, dialect)
    return {
        ...meta,
        kind: "changeColumn",
        table: toTableRef(tableArg),
        column: columnName(oldColumn),
        newType: next.type,
        setNullable: next.nullable,
        newDefault: next.default,
    }
}

function indexOperation(
    meta: OperationBase,
    tableArg: unknown,
    indexArg: unknown,
): Operation {
    const index = indexArg as {
        name?: string
        columnNames?: string[]
        isUnique?: boolean
        isConcurrent?: boolean
        isFulltext?: boolean
        isSpatial?: boolean
        where?: string
        type?: string
    }
    return {
        ...meta,
        kind: "createIndex",
        table: toTableRef(tableArg),
        name: index?.name,
        columns: normalizeIndexColumns(index?.columnNames),
        unique: Boolean(index?.isUnique),
        concurrent: Boolean(index?.isConcurrent),
        where: index?.where || undefined,
        using: index?.type,
        fulltext: Boolean(index?.isFulltext),
        spatial: Boolean(index?.isSpatial),
    }
}

function dropIndexOperation(
    meta: OperationBase,
    tableArg: unknown,
    indexArg: unknown,
): Operation {
    const index = indexArg as { name?: string; isConcurrent?: boolean } | string
    const name = typeof index === "string" ? index : (index?.name ?? "?")
    return {
        ...meta,
        kind: "dropIndex",
        table: toTableRef(tableArg),
        name,
        concurrent:
            typeof index === "string" ? false : Boolean(index?.isConcurrent),
    }
}

function constraintName(value: unknown): string {
    if (typeof value === "string") return value
    return String((value as { name?: string } | undefined)?.name ?? "?")
}

function foreignKeyOperation(
    meta: OperationBase,
    tableArg: unknown,
    fkArg: unknown,
): Operation {
    const fk = fkArg as {
        name?: string
        columnNames?: string[]
        referencedTableName?: string
        referencedSchema?: string
        referencedColumnNames?: string[]
    }
    const referenced = fk?.referencedTableName
        ? fk.referencedSchema
            ? tableRef(fk.referencedTableName, fk.referencedSchema)
            : parseTablePath(fk.referencedTableName)
        : tableRef("?")
    return {
        ...meta,
        kind: "createForeignKey",
        table: toTableRef(tableArg),
        name: fk?.name,
        columns: (fk?.columnNames ?? []).map(String),
        referencedTable: referenced,
        referencedColumns: (fk?.referencedColumnNames ?? []).map(String),
        // TypeORM's typed API cannot emit NOT VALID at all.
        notValid: false,
    }
}

function checkConstraintOperation(
    meta: OperationBase,
    tableArg: unknown,
    checkArg: unknown,
): Operation {
    const check = checkArg as { name?: string; expression?: string }
    return {
        ...meta,
        kind: "createCheckConstraint",
        table: toTableRef(tableArg),
        name: check?.name,
        expression: check?.expression ?? "",
        notValid: false,
    }
}

function uniqueConstraintOperation(
    meta: OperationBase,
    tableArg: unknown,
    uniqueArg: unknown,
): Operation {
    const unique = uniqueArg as { name?: string; columnNames?: string[] }
    return {
        ...meta,
        kind: "createUniqueConstraint",
        table: toTableRef(tableArg),
        name: unique?.name,
        columns: (unique?.columnNames ?? []).map(String),
    }
}

function exclusionConstraintOperation(
    meta: OperationBase,
    tableArg: unknown,
    exclusionArg: unknown,
): Operation {
    const exclusion = exclusionArg as { name?: string; expression?: string }
    return {
        ...meta,
        kind: "createExclusionConstraint",
        table: toTableRef(tableArg),
        name: exclusion?.name,
        expression: exclusion?.expression ?? "",
    }
}

/** Methods we intercept. Anything else passes through untouched. */
export const INTERCEPTED_METHODS = new Set([
    "createTable",
    "dropTable",
    "renameTable",
    "addColumn",
    "addColumns",
    "dropColumn",
    "dropColumns",
    "renameColumn",
    "changeColumn",
    "changeColumns",
    "createIndex",
    "createIndices",
    "dropIndex",
    "dropIndices",
    "createForeignKey",
    "createForeignKeys",
    "dropForeignKey",
    "dropForeignKeys",
    "createCheckConstraint",
    "createCheckConstraints",
    "createUniqueConstraint",
    "createUniqueConstraints",
    "createExclusionConstraint",
    "createExclusionConstraints",
    "createPrimaryKey",
    "updatePrimaryKeys",
    "dropPrimaryKey",
    "clearTable",
    // Previously unintercepted. clearDatabase drops every table and view; dropSchema
    // and dropDatabase are equally unrecoverable.
    "clearDatabase",
    "createSchema",
    "dropSchema",
    "createDatabase",
    "dropDatabase",
    "createView",
    "dropView",
    "changeTableComment",
    "dropUniqueConstraint",
    "dropUniqueConstraints",
    "dropCheckConstraint",
    "dropCheckConstraints",
    "dropExclusionConstraint",
    "dropExclusionConstraints",
    "query",
    "sql",
])
