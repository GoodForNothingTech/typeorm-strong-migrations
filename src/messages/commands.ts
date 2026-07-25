import { supportsConcurrentTableIndex } from "../compat/typeorm"
import type {
    ColumnSpec,
    Dialect,
    IndexColumn,
    TableRef,
} from "../operations/types"
import {
    jsString,
    objectLiteral,
    quoteIdent,
    quoteLiteral,
    quoteTable,
    typeormTablePath,
} from "../util/sql"

/**
 * Messages have to show code in the idiom the migration is already written in.
 * A migration produced by `migration:generate` is raw SQL, so showing it a
 * `queryRunner.createIndex(...)` rewrite would be useless; a hand-written one using
 * the typed API should not be told to drop to strings. Every renderer therefore
 * takes the operation's `source` and emits the matching form.
 */
export interface RenderContext {
    source: "typed" | "sql"
    dialect: Dialect
}

const q = (name: string, ctx: RenderContext): string =>
    quoteIdent(name, ctx.dialect)
const qt = (table: TableRef, ctx: RenderContext): string =>
    quoteTable(table, ctx.dialect)

/** `await queryRunner.query(\`...\`)`, wrapping when the statement is long. */
export function rawQuery(sql: string): string {
    const statement = `await queryRunner.query(\`${sql}\`)`
    if (statement.length <= 96) return statement
    return `await queryRunner.query(\n            \`${sql}\`,\n        )`
}

function indexColumnNames(columns: IndexColumn[]): string[] {
    return columns.map((column) => column.name ?? column.expression ?? "?")
}

function indexColumnSql(columns: IndexColumn[], ctx: RenderContext): string {
    return columns
        .map((column) =>
            column.name ? q(column.name, ctx) : (column.expression ?? "?"),
        )
        .join(", ")
}

/** A stand-in name when the statement did not supply one. */
export function suggestIndexName(
    table: TableRef,
    columns: IndexColumn[],
): string {
    return `IDX_${[table.name, ...indexColumnNames(columns)].join("_")}`
}

// ── indexes ──────────────────────────────────────────────────────────────────

export function createIndexConcurrently(
    table: TableRef,
    columns: IndexColumn[],
    options: {
        name?: string
        unique?: boolean
        where?: string
        using?: string
        include?: string[]
        nullsNotDistinct?: boolean
        /**
         * The statement as written. Supplied when the parse was lossy, so the advice
         * can add CONCURRENTLY to the user's own SQL instead of printing a
         * reconstruction that would silently differ from what they asked for.
         */
        originalSql?: string
    },
    ctx: RenderContext,
): string {
    if (options.originalSql) return addConcurrentlyToSql(options.originalSql)
    const name = options.name ?? suggestIndexName(table, columns)
    // TypeORM 0.3.x has no TableIndex.isConcurrent, so the typed form cannot express
    // the safe version there and we fall back to raw SQL.
    if (ctx.source === "typed" && supportsConcurrentTableIndex()) {
        const literal = objectLiteral([
            ["name", jsString(name)],
            [
                "columnNames",
                `[${indexColumnNames(columns).map(jsString).join(", ")}]`,
            ],
            options.unique ? ["isUnique", "true"] : null,
            options.where ? ["where", jsString(options.where)] : null,
            ["isConcurrent", "true"],
        ])
        return `await queryRunner.createIndex(${jsString(typeormTablePath(table))}, new TableIndex(${literal}))`
    }
    const unique = options.unique ? "UNIQUE " : ""
    const using = options.using ? ` USING ${options.using}` : ""
    const include = options.include?.length
        ? ` INCLUDE (${options.include.map((column) => q(column, ctx)).join(", ")})`
        : ""
    const nullsNotDistinct = options.nullsNotDistinct
        ? " NULLS NOT DISTINCT"
        : ""
    const where = options.where ? ` WHERE ${options.where}` : ""
    return rawQuery(
        `CREATE ${unique}INDEX CONCURRENTLY ${q(name, ctx)} ON ${qt(table, ctx)}` +
            `${using} (${indexColumnSql(columns, ctx)})${include}${nullsNotDistinct}${where}`,
    )
}

/**
 * Inserts CONCURRENTLY into the user's own statement.
 *
 * A token insertion rather than a rebuild, so clauses we do not model survive intact.
 * This is what the advice falls back to whenever the parse was lossy — printing a
 * reconstruction there would recommend a subtly different index than the one asked for.
 */
export function addConcurrentlyToSql(sql: string): string {
    const withConcurrently = sql.replace(
        /\b(CREATE\s+(?:UNIQUE\s+)?INDEX)\b(?!\s+CONCURRENTLY)/i,
        "$1 CONCURRENTLY",
    )
    return rawQuery(withConcurrently.trim())
}

export function dropIndexConcurrently(
    table: TableRef | undefined,
    name: string,
    ctx: RenderContext,
): string {
    if (ctx.source === "typed" && supportsConcurrentTableIndex() && table) {
        const literal = objectLiteral([
            ["name", jsString(name)],
            ["columnNames", "[]"],
            ["isConcurrent", "true"],
        ])
        return `await queryRunner.dropIndex(${jsString(typeormTablePath(table))}, new TableIndex(${literal}))`
    }
    // MySQL has no concurrent drop; the qualified form below is Postgres-only.
    const qualified =
        table?.schema && ctx.dialect === "postgres"
            ? `${q(table.schema, ctx)}.${q(name, ctx)}`
            : q(name, ctx)
    return rawQuery(`DROP INDEX CONCURRENTLY ${qualified}`)
}

// ── columns ──────────────────────────────────────────────────────────────────

function columnTypeSql(column: ColumnSpec): string {
    return column.type?.raw ?? column.type?.baseType ?? "text"
}

/** The column definition minus its default — the first half of the safe split. */
export function addColumnWithoutDefault(
    table: TableRef,
    column: ColumnSpec,
    ctx: RenderContext,
): string {
    if (ctx.source === "typed") {
        const literal = objectLiteral([
            ["name", jsString(column.name)],
            ["type", jsString(column.type?.baseType ?? "text")],
            column.type?.length
                ? ["length", jsString(String(column.type.length))]
                : null,
            // NOT NULL has to wait until the backfill has run.
            ["isNullable", "true"],
        ])
        return `await queryRunner.addColumn(${jsString(typeormTablePath(table))}, new TableColumn(${literal}))`
    }
    const add = ctx.dialect === "postgres" ? "ADD" : "ADD COLUMN"
    return rawQuery(
        `ALTER TABLE ${qt(table, ctx)} ${add} ${q(column.name, ctx)} ${columnTypeSql(column)}`,
    )
}

export function changeColumnDefault(
    table: TableRef,
    column: ColumnSpec,
    ctx: RenderContext,
): string {
    const value = column.default?.raw ?? "NULL"
    if (ctx.dialect === "postgres") {
        return rawQuery(
            `ALTER TABLE ${qt(table, ctx)} ALTER COLUMN ${q(column.name, ctx)} SET DEFAULT ${value}`,
        )
    }
    return rawQuery(
        `ALTER TABLE ${qt(table, ctx)} ALTER ${q(column.name, ctx)} SET DEFAULT ${value}`,
    )
}

export function dropColumn(
    table: TableRef,
    columns: string[],
    ctx: RenderContext,
): string {
    if (ctx.source === "typed") {
        return columns.length === 1
            ? `queryRunner.dropColumn(${jsString(typeormTablePath(table))}, ${jsString(columns[0]!)})`
            : `queryRunner.dropColumns(${jsString(typeormTablePath(table))}, [${columns.map(jsString).join(", ")}])`
    }
    const clauses = columns
        .map((name) => `DROP COLUMN ${q(name, ctx)}`)
        .join(", ")
    return `queryRunner.query(\`ALTER TABLE ${qt(table, ctx)} ${clauses}\`)`
}

export function dropTable(table: TableRef, ctx: RenderContext): string {
    return ctx.source === "typed"
        ? `queryRunner.dropTable(${jsString(typeormTablePath(table))})`
        : `queryRunner.query(\`DROP TABLE ${qt(table, ctx)}\`)`
}

// ── constraints ──────────────────────────────────────────────────────────────

export function addForeignKeyNotValid(
    table: TableRef,
    options: {
        name: string
        columns: string[]
        referencedTable: TableRef
        referencedColumns: string[]
    },
    ctx: RenderContext,
): string {
    const columns = options.columns.map((name) => q(name, ctx)).join(", ")
    const referenced = options.referencedColumns
        .map((name) => q(name, ctx))
        .join(", ")
    return rawQuery(
        `ALTER TABLE ${qt(table, ctx)} ADD CONSTRAINT ${q(options.name, ctx)} ` +
            `FOREIGN KEY (${columns}) REFERENCES ${qt(options.referencedTable, ctx)} (${referenced}) NOT VALID`,
    )
}

export function removeForeignKey(
    table: TableRef,
    name: string,
    ctx: RenderContext,
): string {
    return ctx.source === "typed"
        ? `await queryRunner.dropForeignKey(${jsString(typeormTablePath(table))}, ${jsString(name)})`
        : rawQuery(
              `ALTER TABLE ${qt(table, ctx)} DROP CONSTRAINT ${q(name, ctx)}`,
          )
}

export function addCheckConstraintNotValid(
    table: TableRef,
    name: string,
    expression: string,
    ctx: RenderContext,
): string {
    return rawQuery(
        `ALTER TABLE ${qt(table, ctx)} ADD CONSTRAINT ${q(name, ctx)} CHECK (${expression}) NOT VALID`,
    )
}

export function removeCheckConstraint(
    table: TableRef,
    name: string,
    ctx: RenderContext,
): string {
    return ctx.source === "typed"
        ? `await queryRunner.dropCheckConstraint(${jsString(typeormTablePath(table))}, ${jsString(name)})`
        : rawQuery(
              `ALTER TABLE ${qt(table, ctx)} DROP CONSTRAINT ${q(name, ctx)}`,
          )
}

export function validateConstraint(
    table: TableRef,
    name: string,
    ctx: RenderContext,
): string {
    return rawQuery(
        `ALTER TABLE ${qt(table, ctx)} VALIDATE CONSTRAINT ${q(name, ctx)}`,
    )
}

export function setNotNull(
    table: TableRef,
    column: string,
    ctx: RenderContext,
): string {
    return rawQuery(
        `ALTER TABLE ${qt(table, ctx)} ALTER COLUMN ${q(column, ctx)} SET NOT NULL`,
    )
}

export function addUniqueConstraintUsingIndex(
    table: TableRef,
    name: string,
    indexName: string,
    ctx: RenderContext,
): string {
    return rawQuery(
        `ALTER TABLE ${qt(table, ctx)} ADD CONSTRAINT ${q(name, ctx)} UNIQUE USING INDEX ${q(indexName, ctx)}`,
    )
}

export function dropConstraint(
    table: TableRef,
    name: string,
    ctx: RenderContext,
): string {
    return rawQuery(
        `ALTER TABLE ${qt(table, ctx)} DROP CONSTRAINT ${q(name, ctx)}`,
    )
}

// ── enums ────────────────────────────────────────────────────────────────────

export function addEnumValue(
    type: TableRef,
    value: string,
    after: string,
    ctx: RenderContext,
): string {
    return rawQuery(
        `ALTER TYPE ${qt(type, ctx)} ADD VALUE ${quoteLiteral(value)} AFTER ${quoteLiteral(after)}`,
    )
}

// ── backfill ─────────────────────────────────────────────────────────────────

/**
 * A batched rewrite of an unbounded UPDATE. Uses the query builder rather than raw
 * SQL so the snippet type-checks against TypeORM's own API — the snippet
 * compilation test depends on that.
 */
export function batchedBackfill(
    table: TableRef,
    options: { setClause?: string; whereClause?: string } = {},
): string {
    const path = jsString(typeormTablePath(table))
    const set = options.setClause ?? "{ /* columns to set */ }"
    const where = options.whereClause ?? "/* rows still needing the backfill */"
    return `for (;;) {
            const result = await queryRunner.manager
                .createQueryBuilder()
                .update(${path})
                .set(${set})
                .where(\`"id" IN (SELECT "id" FROM ${path} WHERE ${where} LIMIT 10000)\`)
                .execute()
            if (!result.affected) break
            await new Promise((resolve) => setTimeout(resolve, 10))
        }`
}
