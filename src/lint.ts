import { readFileSync } from "node:fs"
import type { QueryRunner } from "typeorm"
import { createAdapter } from "./adapters/factory"
import type { CheckKey } from "./checks/keys"
import { checksFor } from "./checks/registry"
import type { CheckContext } from "./checks/types"
import type { ResolvedConfig } from "./config"
import { headerFor } from "./messages/error-messages"
import { baseVars, renderMessage } from "./messages/format"
import type { Dialect, Operation, TableRef } from "./operations/types"
import { sameTable } from "./operations/types"
import { analyzeSql } from "./sql/analyze"
import { bookkeepingConfig, classify } from "./sql/classify"
import { state } from "./state"

export interface LintFinding {
    key: CheckKey | "unparsed"
    header: string
    message: string
    sql: string
    file?: string
    /** 1-indexed line of the offending statement within the file. */
    line?: number
    migrationName?: string
}

export interface LintResult {
    findings: LintFinding[]
    /** Statements the analyzer could not interpret, reported even when not fatal. */
    unparsed: number
    statements: number
}

/**
 * Static linting: the same checks, with no database.
 *
 * This is not in the gem — it cannot be, because Rails migrations are Ruby that has
 * to be executed to be understood. TypeORM migrations carry their DDL as string
 * literals, so a source file can be checked in CI before anything connects.
 *
 * The tradeoff is that every check needing live introspection is skipped, and
 * `isNewTable` is tracked only within a single file.
 */
export function lintSql(
    sql: string,
    options: {
        dialect: Dialect
        config?: ResolvedConfig
        file?: string
        migrationName?: string
        sourceOffsetLine?: number
        migrationsTableName?: string
        metadataTableName?: string
        /**
         * Tables created earlier in the same migration. A migration is usually a
         * sequence of separate `query()` calls, so this has to be threaded across
         * them or an index on a table created two lines up looks unsafe.
         */
        newTables?: TableRef[]
    },
): LintResult {
    const config = options.config ?? state().config
    const operations = analyzeSql(sql, options.dialect)
    const bookkeeping = bookkeepingConfig({
        migrationsTableName: options.migrationsTableName,
        metadataTableName: options.metadataTableName,
    })

    const findings: LintFinding[] = []
    const newTables: TableRef[] = options.newTables ?? []
    let unparsed = 0
    let statements = 0

    for (const op of operations) {
        const statementClass = classify(op, bookkeeping)
        if (statementClass === "bookkeeping" || statementClass === "benign")
            continue
        statements += 1

        if (
            statementClass === "ddl-unparsed" ||
            statementClass === "unparseable"
        ) {
            unparsed += 1
            if (
                op.kind === "unknown" &&
                statementClass === "ddl-unparsed" &&
                config.unknownSql !== "ignore"
            ) {
                findings.push({
                    key: "rawQuery",
                    header: headerFor("rawQuery"),
                    message: renderMessage(
                        "rawQuery",
                        {
                            ...baseVars(options.migrationName ?? "Migration"),
                            sql: op.sql,
                        },
                        config,
                    ),
                    sql: op.sql,
                    file: options.file,
                    line: lineOf(sql, op, options.sourceOffsetLine),
                    migrationName: options.migrationName,
                })
            }
            continue
        }

        const ctx = staticContext(
            config,
            options.dialect,
            newTables,
            options.migrationName,
        )
        for (const check of checksFor(op.kind)) {
            if (check.needsIntrospection) continue
            const verdicts = check.run(op, ctx)
            if (!Array.isArray(verdicts)) continue
            for (const verdict of verdicts) {
                if (verdict.type !== "unsafe") continue
                if (!config.enabledChecks.has(verdict.key)) continue
                if (op.markers?.safetyAssured) continue
                findings.push({
                    key: verdict.key,
                    header: verdict.header ?? headerFor(verdict.key),
                    message: renderMessage(
                        verdict.key,
                        {
                            ...baseVars(options.migrationName ?? "Migration"),
                            ...verdict.vars,
                        },
                        config,
                    ),
                    sql: op.span?.sql ?? "",
                    file: options.file,
                    line: lineOf(sql, op, options.sourceOffsetLine),
                    migrationName: options.migrationName,
                })
            }
        }

        if (op.kind === "createTable") newTables.push(op.table)
    }

    return { findings, unparsed, statements }
}

/**
 * A CheckContext with no database behind it. Anything requiring introspection is
 * filtered out before this is used, and the remaining lookups answer "unknown".
 */
function offlineQueryRunner(): QueryRunner {
    return {
        query: () => {
            throw new Error("lint runs without a database connection")
        },
    } as unknown as QueryRunner
}

function staticContext(
    config: ResolvedConfig,
    dialect: Dialect,
    newTables: TableRef[],
    migrationName?: string,
): CheckContext {
    const unavailable = async (): Promise<undefined> => undefined
    return {
        dataSource: undefined as never,
        config,
        // The real adapter, not a hand-copied capability table. The transcribed
        // literal had drifted — `changeTypeSafe: async () => false` flagged every
        // widening `ALTER COLUMN ... TYPE` that the runtime allows, and
        // `autoIncrementingTypes: []` disabled that check outright — so CI and the
        // runtime disagreed on identical SQL. Adapters only touch the query runner
        // from `exec`/`rows`, which the introspecting checks skipped here never reach.
        adapter: createAdapter(dialect, offlineQueryRunner()),
        dialect,
        direction: "up",
        migration: { name: migrationName ?? "Migration" },
        queryRunner: undefined as never,
        transactionMode: "all",
        transactionModeInferred: true,
        inTransaction: false,
        introspect: {
            columns: unavailable,
            column: unavailable,
            isIndexed: unavailable,
            checkConstraintsOnColumn: unavailable,
            constraint: unavailable,
            writesBlocked: unavailable,
            isVolatileFunction: async () => true,
            charsetMaxLen: unavailable,
            invalidIndexExists: unavailable,
            timeZone: unavailable,
        },
        canIntrospect: false,
        render: { source: "sql", dialect },
        // `sameTable`, matching MigrationState. Comparing `key` directly made an
        // unqualified reference miss a schema-qualified CREATE TABLE in the same file.
        isNewTable: (table) =>
            newTables.some((known) => sameTable(known, table)),
        isNewColumn: (table) =>
            newTables.some((known) => sameTable(known, table)),
        enabled: (key) => config.enabledChecks.has(key),
        entityName: () => undefined,
        entityProperty: () => undefined,
    }
}

function lineOf(sql: string, op: Operation, offset = 1): number | undefined {
    const start = op.span?.start
    if (start === undefined) return undefined
    return sql.slice(0, start).split("\n").length + offset - 1
}

/**
 * Extracts SQL from `queryRunner.query(\`...\`)` calls in a migration source file
 * and lints each one.
 *
 * Deliberately a regex over template literals rather than a TypeScript parse: the
 * CLI must work on `.ts` and compiled `.js` alike without a compiler dependency,
 * and the pattern `migration:generate` emits is entirely regular.
 */
export function lintFiles(
    files: string[],
    options: {
        dialect: Dialect
        config?: ResolvedConfig
        migrationsTableName?: string
        metadataTableName?: string
    },
): LintResult {
    const combined: LintResult = { findings: [], unparsed: 0, statements: 0 }

    for (const file of files) {
        let source: string
        try {
            source = readFileSync(file, "utf8")
        } catch {
            continue
        }
        const migrationName = /export\s+class\s+(\w+)/.exec(source)?.[1]
        // Shared across every query() call in the file, so a table created in one
        // statement exempts operations on it in later ones.
        const newTables: TableRef[] = []

        for (const { sql, line } of extractQueryCalls(source)) {
            const result = lintSql(sql, {
                dialect: options.dialect,
                config: options.config,
                file,
                migrationName,
                sourceOffsetLine: line,
                newTables,
                migrationsTableName: options.migrationsTableName,
                metadataTableName: options.metadataTableName,
            })
            combined.findings.push(...result.findings)
            combined.unparsed += result.unparsed
            combined.statements += result.statements
        }
    }

    return combined
}

const QUERY_CALL = /\.query\(\s*`((?:[^`\\]|\\.)*)`/g

export function extractQueryCalls(
    source: string,
): Array<{ sql: string; line: number }> {
    const found: Array<{ sql: string; line: number }> = []
    for (const match of source.matchAll(QUERY_CALL)) {
        // `migration:generate` escapes backticks and `${` for the source file; undo
        // that to recover the SQL the driver actually receives.
        const sql = match[1]!
            .replace(/\\`/g, "`")
            .replace(/\\\$\{/g, "${")
            .replace(/\\\\/g, "\\")
        found.push({
            sql,
            line: source.slice(0, match.index).split("\n").length,
        })
    }
    return found
}
