import type { Dialect, TableRef } from "../operations/types"

/** Postgres uses double quotes with `""` escaping; MySQL/MariaDB use backticks. */
export function quoteIdent(name: string, dialect: Dialect): string {
    return dialect === "postgres"
        ? `"${name.replaceAll('"', '""')}"`
        : `\`${name.replaceAll("`", "``")}\``
}

export function quoteTable(table: TableRef, dialect: Dialect): string {
    const name = quoteIdent(table.name, dialect)
    return table.schema ? `${quoteIdent(table.schema, dialect)}.${name}` : name
}

export function quoteLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`
}

/** A JS string literal for embedding in rendered TypeScript. */
export function jsString(value: string): string {
    return JSON.stringify(value)
}

/**
 * Table reference as TypeORM's DDL methods take it: `"schema.table"` or `"table"`.
 */
export function typeormTablePath(table: TableRef): string {
    return table.schema ? `${table.schema}.${table.name}` : table.name
}

/** Renders a value as a TypeScript object-literal entry list. */
export function objectLiteral(entries: Array<[string, string] | null>): string {
    const kept = entries.filter(
        (entry): entry is [string, string] => entry !== null,
    )
    if (kept.length === 0) return "{}"
    return `{ ${kept.map(([key, value]) => `${key}: ${value}`).join(", ")} }`
}

/** Singularized PascalCase guess at an entity name, used when metadata has none. */
export function guessEntityName(tableName: string): string {
    const pascal = tableName
        .split(/[^A-Za-z0-9]+/)
        .filter(Boolean)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join("")
    if (/(ss|us|is)$/i.test(pascal)) return pascal
    if (/ies$/i.test(pascal)) return pascal.slice(0, -3) + "y"
    if (/s$/i.test(pascal)) return pascal.slice(0, -1)
    return pascal
}
