import type { DataSource, QueryRunner } from "typeorm"
import type { ColumnSpec, Dialect, TableRef } from "../../src/operations/types"

/**
 * An in-memory stand-in for a QueryRunner.
 *
 * The overwhelming majority of the suite asserts *which* check fires and *what it
 * says*, neither of which needs a database. Only genuinely stateful behaviour —
 * timeouts, ANALYZE, transaction modes — is exercised against real engines in the
 * integration project.
 */
export interface FakeTable {
    columns: ColumnSpec[]
    indexedColumns?: string[]
    checkConstraints?: Array<{
        name: string
        definition: string
        validated: boolean
        type?: string
    }>
}

export interface FakeOptions {
    dialect?: Dialect
    isTransactionActive?: boolean
    tables?: Record<string, FakeTable>
    /** Postgres function volatility, keyed by bare function name. */
    volatileFunctions?: Record<string, boolean>
    writesBlocked?: boolean
    timeZone?: string
    charsetMaxLen?: number
    strictMode?: boolean
    entities?: Array<{
        name: string
        tableName: string
        columns: Array<{ databaseName: string; propertyName: string }>
    }>
    migrationsTableName?: string
}

export interface FakeRunner {
    queryRunner: QueryRunner
    dataSource: DataSource
    executed: string[]
    options: FakeOptions
}

export function createFakeRunner(options: FakeOptions = {}): FakeRunner {
    const executed: string[] = []
    const dialect = options.dialect ?? "postgres"

    const dataSource = {
        options: {
            type: dialect,
            database: "test",
            migrationsTableName: options.migrationsTableName,
        },
        driver: { version: dialect === "postgres" ? "16.2" : "8.4.0" },
        entityMetadatas: options.entities ?? [],
        logger: undefined,
        isInitialized: true,
    } as unknown as DataSource

    const queryRunner = {
        data: {},
        isTransactionActive: options.isTransactionActive ?? false,
        connection: dataSource,
        dataSource,
        async query(sql: string, parameters?: unknown[]) {
            executed.push(sql)
            return fakeQueryResult(sql, options, parameters)
        },
        async getTable(path: string) {
            const table = options.tables?.[path.split(".").pop() ?? path]
            if (!table) return undefined
            return {
                name: path,
                columns: table.columns.map((column) => ({
                    name: column.name,
                    type: column.type?.baseType ?? "text",
                    length: column.type?.length
                        ? String(column.type.length)
                        : "",
                    precision: column.type?.precision ?? null,
                    scale: column.type?.scale,
                    isArray: column.type?.isArray ?? false,
                    isNullable: column.nullable ?? true,
                    isPrimary: column.isPrimaryKey ?? false,
                    isUnique: column.isUnique ?? false,
                    isGenerated: !!column.autoIncrement,
                    generationStrategy: column.autoIncrement
                        ? "increment"
                        : undefined,
                    asExpression: column.generated?.expression,
                    generatedType: column.generated?.storage,
                    default: column.default?.raw,
                })),
                indices: (table.indexedColumns ?? []).map((name) => ({
                    name: `IDX_${name}`,
                    columnNames: [name],
                })),
            }
        },
        async startTransaction() {},
        async commitTransaction() {},
        async rollbackTransaction() {},
        async release() {},

        // TypeORM's typed DDL helpers all funnel through BaseQueryRunner.executeQueries,
        // which calls `this.query(...)`. Reproducing that here is what makes the
        // double-reporting regression test meaningful: if the proxy passed itself as
        // the receiver, this inner call would be intercepted a second time.
        ...typedDdlStubs(),
    } as unknown as QueryRunner

    return { queryRunner, dataSource, executed, options }
}

interface QueryCapable {
    query(sql: string, parameters?: unknown[]): Promise<unknown>
}

function typedDdlStubs(): Record<string, (...args: any[]) => Promise<void>> {
    const emit = (sql: string) =>
        async function (this: QueryCapable): Promise<void> {
            await this.query(sql)
        }

    return {
        createIndex: emit("CREATE INDEX <typed>"),
        createIndices: emit("CREATE INDEX <typed>"),
        dropIndex: emit("DROP INDEX <typed>"),
        dropIndices: emit("DROP INDEX <typed>"),
        addColumn: emit("ALTER TABLE <typed> ADD"),
        addColumns: emit("ALTER TABLE <typed> ADD"),
        dropColumn: emit("ALTER TABLE <typed> DROP COLUMN"),
        dropColumns: emit("ALTER TABLE <typed> DROP COLUMN"),
        changeColumn: emit("ALTER TABLE <typed> ALTER COLUMN"),
        changeColumns: emit("ALTER TABLE <typed> ALTER COLUMN"),
        renameColumn: emit("ALTER TABLE <typed> RENAME COLUMN"),
        createTable: emit("CREATE TABLE <typed>"),
        dropTable: emit("DROP TABLE <typed>"),
        renameTable: emit("ALTER TABLE <typed> RENAME TO"),
        createForeignKey: emit("ALTER TABLE <typed> ADD CONSTRAINT"),
        createForeignKeys: emit("ALTER TABLE <typed> ADD CONSTRAINT"),
        dropForeignKey: emit("ALTER TABLE <typed> DROP CONSTRAINT"),
        createCheckConstraint: emit("ALTER TABLE <typed> ADD CONSTRAINT"),
        createCheckConstraints: emit("ALTER TABLE <typed> ADD CONSTRAINT"),
        createUniqueConstraint: emit("ALTER TABLE <typed> ADD CONSTRAINT"),
        createUniqueConstraints: emit("ALTER TABLE <typed> ADD CONSTRAINT"),
        createExclusionConstraint: emit("ALTER TABLE <typed> ADD CONSTRAINT"),
        createExclusionConstraints: emit("ALTER TABLE <typed> ADD CONSTRAINT"),
        createPrimaryKey: emit("ALTER TABLE <typed> ADD PRIMARY KEY"),
        clearTable: emit("TRUNCATE TABLE <typed>"),
        // Previously unintercepted; TypeORM funnels these through query() too.
        clearDatabase: emit("DROP TABLE <typed all>"),
        createSchema: emit("CREATE SCHEMA <typed>"),
        dropSchema: emit("DROP SCHEMA <typed>"),
        createDatabase: emit("CREATE DATABASE <typed>"),
        dropDatabase: emit("DROP DATABASE <typed>"),
        createView: emit("CREATE VIEW <typed>"),
        dropView: emit("DROP VIEW <typed>"),
        changeTableComment: emit("ALTER TABLE <typed> COMMENT"),
        dropPrimaryKey: emit("ALTER TABLE <typed> DROP CONSTRAINT"),
        updatePrimaryKeys: emit("ALTER TABLE <typed> ADD PRIMARY KEY"),
        dropUniqueConstraint: emit("ALTER TABLE <typed> DROP CONSTRAINT"),
        dropUniqueConstraints: emit("ALTER TABLE <typed> DROP CONSTRAINT"),
        dropCheckConstraint: emit("ALTER TABLE <typed> DROP CONSTRAINT"),
        dropCheckConstraints: emit("ALTER TABLE <typed> DROP CONSTRAINT"),
        dropExclusionConstraint: emit("ALTER TABLE <typed> DROP CONSTRAINT"),
        dropExclusionConstraints: emit("ALTER TABLE <typed> DROP CONSTRAINT"),
    }
}

function fakeQueryResult(
    sql: string,
    options: FakeOptions,
    parameters?: unknown[],
): unknown[] {
    if (/pg_proc/.test(sql)) {
        const name = String(parameters?.[0] ?? "")
        const volatile = options.volatileFunctions?.[name]
        // An unknown function has no row, which the introspector reads as volatile —
        // the same fail-safe default the gem uses.
        if (volatile === undefined) return []
        return volatile ? [{ provolatile: "v" }] : [{ provolatile: "s" }]
    }
    if (/pg_locks/.test(sql))
        return options.writesBlocked ? [{ "?column?": 1 }] : []
    if (/pg_constraint/.test(sql)) {
        const table = Object.values(options.tables ?? {}).find(
            (candidate) => candidate.checkConstraints !== undefined,
        )
        return (table?.checkConstraints ?? []).map((constraint) => ({
            name: constraint.name,
            type: constraint.type ?? "c",
            definition: constraint.definition,
            validated: constraint.validated,
        }))
    }
    if (/SHOW timezone/i.test(sql))
        return [{ TimeZone: options.timeZone ?? "UTC" }]
    if (/SHOW lock_timeout/i.test(sql)) return [{ lock_timeout: "0" }]
    if (/CHARACTER_SETS/i.test(sql))
        return [{ maxlen: options.charsetMaxLen ?? 4 }]
    if (/sql_mode/i.test(sql)) {
        return [
            {
                sql_mode:
                    options.strictMode === false
                        ? "NO_ENGINE_SUBSTITUTION"
                        : "STRICT_TRANS_TABLES",
            },
        ]
    }
    return []
}

export function fakeTableRef(name: string, schema?: string): TableRef {
    return {
        name,
        schema,
        key: schema
            ? `${schema.toLowerCase()}.${name.toLowerCase()}`
            : name.toLowerCase(),
    }
}
