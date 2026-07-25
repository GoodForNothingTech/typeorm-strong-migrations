import type { QueryRunner } from "typeorm"
import type { ColumnSpec, Dialect, TableRef } from "../operations/types"
import { parseSqlType } from "../sql/types"
import { quoteLiteral } from "../util/sql"
import type { Introspector, PgConstraint } from "./types"

/**
 * Live database lookups for the checks that need them.
 *
 * Two rules govern everything here.
 *
 * 1. **Never break the migration.** Every probe is wrapped and degrades to
 *    `undefined`, mirroring the gem's `connection.columns(table) rescue []`. A
 *    linter that takes down a deploy because its own introspection failed is worse
 *    than one that misses a check.
 * 2. **Never re-enter our interception.** Probes run on the unwrapped QueryRunner
 *    and set a re-entrancy flag the logger layer honours.
 */
export class LiveIntrospector implements Introspector {
    /** Read by the logger layer to ignore our own traffic. */
    busy = false

    private readonly columnCache = new Map<string, ColumnSpec[] | undefined>()
    private readonly indexCache = new Map<string, boolean | undefined>()
    private readonly constraintCache = new Map<
        string,
        PgConstraint[] | undefined
    >()
    private readonly volatileCache = new Map<string, boolean>()
    private readonly charsetCache = new Map<string, number | undefined>()

    constructor(
        private readonly queryRunner: QueryRunner,
        private readonly dialect: Dialect,
    ) {}

    private async run<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
        const wasBusy = this.busy
        this.busy = true
        try {
            return await fn()
        } catch {
            // A failed probe means "unknown", never a thrown migration.
            return fallback
        } finally {
            this.busy = wasBusy
        }
    }

    private async query(sql: string, parameters?: unknown[]): Promise<any[]> {
        const result = await this.queryRunner.query(
            sql,
            parameters as any[] | undefined,
        )
        return Array.isArray(result) ? result : []
    }

    /** Invalidate after DDL touches a table so later checks see current state. */
    forget(table: TableRef): void {
        const prefix = `${table.key}:`
        // Two key shapes are in play: the bare table key (columns, constraints) and
        // `table:column` (indexes, charsets). Matching only the prefix left the
        // constraint cache permanently stale, so a column proven NOT NULL earlier in
        // the same migration still read as unproven.
        const caches: Array<Map<string, unknown>> = [
            this.columnCache,
            this.indexCache,
            this.constraintCache,
            this.charsetCache,
        ]
        for (const cache of caches) {
            for (const key of [...cache.keys()]) {
                if (key === table.key || key.startsWith(prefix))
                    cache.delete(key)
            }
        }
    }

    async columns(table: TableRef): Promise<ColumnSpec[] | undefined> {
        if (this.columnCache.has(table.key))
            return this.columnCache.get(table.key)
        const result = await this.run(async () => {
            const path = table.schema
                ? `${table.schema}.${table.name}`
                : table.name
            const found = await this.queryRunner.getTable(path)
            if (!found) return undefined
            return found.columns.map((column): ColumnSpec => ({
                name: column.name,
                type: parseSqlType(buildTypeText(column), this.dialect),
                nullable: column.isNullable,
                default:
                    column.default === undefined || column.default === null
                        ? undefined
                        : {
                              kind: "expression",
                              raw: String(column.default),
                              containsCall: String(column.default).includes(
                                  "(",
                              ),
                          },
                isPrimaryKey: column.isPrimary,
                isUnique: column.isUnique,
                generated: column.asExpression
                    ? {
                          expression: column.asExpression,
                          storage:
                              column.generatedType === "STORED"
                                  ? "STORED"
                                  : "VIRTUAL",
                      }
                    : undefined,
                autoIncrement:
                    column.isGenerated &&
                    column.generationStrategy === "increment"
                        ? {
                              style:
                                  this.dialect === "postgres"
                                      ? "serial"
                                      : "autoIncrement",
                          }
                        : undefined,
            }))
        }, undefined)
        this.columnCache.set(table.key, result)
        return result
    }

    async column(
        table: TableRef,
        name: string,
    ): Promise<ColumnSpec | undefined> {
        const all = await this.columns(table)
        return all?.find(
            (column) => column.name.toLowerCase() === name.toLowerCase(),
        )
    }

    async isIndexed(
        table: TableRef,
        column: string,
    ): Promise<boolean | undefined> {
        const key = `${table.key}:${column.toLowerCase()}`
        if (this.indexCache.has(key)) return this.indexCache.get(key)
        const result = await this.run(async () => {
            const path = table.schema
                ? `${table.schema}.${table.name}`
                : table.name
            const found = await this.queryRunner.getTable(path)
            if (!found) return undefined
            return found.indices.some((index) =>
                index.columnNames.some(
                    (name) => name.toLowerCase() === column.toLowerCase(),
                ),
            )
        }, undefined)
        this.indexCache.set(key, result)
        return result
    }

    /**
     * TypeORM's Table model carries no constraint-validity flag, so this is one of
     * the few places that has to read the catalog directly.
     */
    private async pgConstraints(
        table: TableRef,
    ): Promise<PgConstraint[] | undefined> {
        if (this.dialect !== "postgres") return []
        if (this.constraintCache.has(table.key))
            return this.constraintCache.get(table.key)
        const result = await this.run(async () => {
            const qualified = table.schema
                ? `${quoteLiteral(`"${table.schema}"."${table.name}"`)}`
                : quoteLiteral(`"${table.name}"`)
            const rows = await this.query(
                `SELECT conname AS name, contype::text AS type,
                        pg_get_constraintdef(oid) AS definition, convalidated AS validated
                 FROM pg_constraint
                 WHERE conrelid = ${qualified}::regclass`,
            )
            return rows.map((row): PgConstraint => ({
                name: String(row.name),
                type: String(row.type),
                definition: String(row.definition ?? ""),
                validated: row.validated === true || row.validated === "t",
            }))
        }, undefined)
        this.constraintCache.set(table.key, result)
        return result
    }

    async checkConstraintsOnColumn(
        table: TableRef,
        column: string,
    ): Promise<PgConstraint[] | undefined> {
        const all = await this.pgConstraints(table)
        if (!all) return undefined
        // Word-boundary match on the column name, as the gem does.
        const pattern = new RegExp(`\\b${escapeRegExp(column)}\\b`)
        return all.filter(
            (constraint) =>
                constraint.type === "c" && pattern.test(constraint.definition),
        )
    }

    async constraint(
        table: TableRef,
        name: string,
    ): Promise<PgConstraint | undefined> {
        const all = await this.pgConstraints(table)
        return all?.find((constraint) => constraint.name === name)
    }

    async writesBlocked(): Promise<boolean | undefined> {
        if (this.dialect !== "postgres") return undefined
        return this.run(async () => {
            const rows = await this.query(
                `SELECT 1 FROM pg_locks
                 WHERE mode IN ('ShareRowExclusiveLock', 'AccessExclusiveLock')
                   AND pid = pg_backend_pid()
                 LIMIT 1`,
            )
            return rows.length > 0
        }, undefined)
    }

    /** Unknown functions count as volatile, matching the gem's fail-safe default. */
    async isVolatileFunction(name: string, schema?: string): Promise<boolean> {
        if (this.dialect !== "postgres") return false
        const key = schema ? `${schema}.${name}` : name
        const cached = this.volatileCache.get(key)
        if (cached !== undefined) return cached
        const result = await this.run(async () => {
            const rows = await this.query(
                `SELECT provolatile::text FROM pg_proc WHERE proname = $1`,
                [name],
            )
            if (rows.length === 0) return true
            return rows.some((row) => String(row.provolatile) === "v")
        }, true)
        this.volatileCache.set(key, result)
        return result
    }

    async charsetMaxLen(
        table: TableRef,
        column: string,
    ): Promise<number | undefined> {
        if (this.dialect === "postgres") return undefined
        const key = `${table.key}:${column.toLowerCase()}`
        if (this.charsetCache.has(key)) return this.charsetCache.get(key)
        const result = await this.run(async () => {
            const rows = await this.query(
                `SELECT cs.MAXLEN AS maxlen
                 FROM INFORMATION_SCHEMA.CHARACTER_SETS cs
                 INNER JOIN INFORMATION_SCHEMA.COLUMNS c
                         ON c.CHARACTER_SET_NAME = cs.CHARACTER_SET_NAME
                 WHERE c.TABLE_SCHEMA = ${table.schema ? "?" : "database()"}
                   AND c.TABLE_NAME = ?
                   AND c.COLUMN_NAME = ?`,
                table.schema
                    ? [table.schema, table.name, column]
                    : [table.name, column],
            )
            const maxlen = rows[0]?.maxlen
            return maxlen === undefined ? undefined : Number(maxlen)
        }, undefined)
        this.charsetCache.set(key, result)
        return result
    }

    async invalidIndexExists(
        name: string,
        schema?: string,
    ): Promise<boolean | undefined> {
        if (this.dialect !== "postgres") return undefined
        return this.run(async () => {
            const rows = await this.query(
                `SELECT c.relname
                 FROM pg_index i
                 JOIN pg_class c ON c.oid = i.indexrelid
                 JOIN pg_namespace n ON n.oid = c.relnamespace
                 WHERE NOT i.indisvalid
                   AND c.relname = $1
                   AND ($2::text IS NULL OR n.nspname = $2)`,
                [name, schema ?? null],
            )
            return rows.length > 0
        }, undefined)
    }

    async timeZone(): Promise<string | undefined> {
        if (this.dialect !== "postgres") return undefined
        // Deliberately not memoized: the gem refetches because a migration can
        // change the session time zone partway through.
        return this.run(async () => {
            const rows = await this.query("SHOW timezone")
            const row = rows[0]
            if (!row) return undefined
            return String(row.TimeZone ?? row.timezone ?? Object.values(row)[0])
        }, undefined)
    }
}

function buildTypeText(column: {
    type: string
    length?: string
    precision?: number | null
    scale?: number
    isArray?: boolean
}): string {
    let text = column.type
    if (column.length) text += `(${column.length})`
    else if (column.precision !== undefined && column.precision !== null) {
        text +=
            column.scale === undefined
                ? `(${column.precision})`
                : `(${column.precision},${column.scale})`
    }
    if (column.isArray) text += "[]"
    return text
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
