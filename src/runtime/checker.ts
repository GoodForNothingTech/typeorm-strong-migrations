import type { DataSource, QueryRunner } from "typeorm"
import type { Adapter, Introspector } from "../adapters/types"
import { LiveIntrospector } from "../adapters/introspection"
import { checksFor } from "../checks/registry"
import type {
    CheckContext,
    CheckVerdict,
    MigrationMeta,
    TransactionMode,
} from "../checks/types"
import type { CheckKey } from "../checks/keys"
import type { ResolvedConfig } from "../config"
import {
    AggregateUnsafeMigrationError,
    HEADERS,
    UnsafeMigrationError,
} from "../errors"
import type { RenderContext } from "../messages/commands"
import { headerFor } from "../messages/error-messages"
import { baseVars, renderMessage } from "../messages/format"
import type { Dialect, Operation, TableRef } from "../operations/types"
import { operationTables } from "../operations/types"
import { parseDuration } from "../util/duration"
import { quoteIdent } from "../util/sql"
import { MigrationState } from "./checker-state"
import { runWithRetries } from "./retry"

/** Treats "", "0", "false", "no" and "off" as unset, however the shell spells it. */
function envFlag(value: string | undefined): boolean {
    if (!value) return false
    const normalized = value.trim().toLowerCase()
    return (
        normalized !== "" &&
        normalized !== "0" &&
        normalized !== "false" &&
        normalized !== "no" &&
        normalized !== "off"
    )
}

export interface CheckerOptions {
    dataSource: DataSource
    queryRunner: QueryRunner
    migration: MigrationMeta
    direction: "up" | "down"
    config: ResolvedConfig
    adapter: Adapter
    transactionMode: TransactionMode
    transactionModeInferred: boolean
}

export class Checker {
    readonly dataSource: DataSource
    /** Always the unwrapped runner: introspection must not re-enter interception. */
    readonly rawQueryRunner: QueryRunner
    readonly migration: MigrationMeta
    readonly direction: "up" | "down"
    readonly config: ResolvedConfig
    readonly adapter: Adapter
    readonly transactionMode: TransactionMode
    readonly transactionModeInferred: boolean
    readonly state: MigrationState
    readonly introspector: LiveIntrospector

    /** Set by safetyAssured(); shadowed on a prototype fork so it cannot leak. */
    readonly safetyAssured: boolean = false

    constructor(options: CheckerOptions) {
        this.dataSource = options.dataSource
        this.rawQueryRunner = options.queryRunner
        this.migration = options.migration
        this.direction = options.direction
        this.config = options.config
        this.adapter = options.adapter
        this.transactionMode = options.transactionMode
        this.transactionModeInferred = options.transactionModeInferred
        this.state = new MigrationState()
        this.introspector = new LiveIntrospector(
            options.queryRunner,
            this.dialect,
        )
    }

    get dialect(): Dialect {
        return this.adapter.dialect
    }

    /** True while our own introspection queries are in flight. */
    get introspecting(): boolean {
        return this.introspector.busy
    }

    /**
     * A prototype fork: mutable state stays shared by reference while the flag is
     * shadowed. Restoring is structural — there is no boolean to forget to reset,
     * and no window where a concurrent task sees the wrong value.
     */
    fork(overrides: { safetyAssured?: boolean }): Checker {
        return Object.create(this, {
            safetyAssured: {
                value: overrides.safetyAssured ?? this.safetyAssured,
            },
        }) as Checker
    }

    private log(message: string): void {
        if (this.config.logger) this.config.logger("warn", message)
        else if (typeof this.dataSource.logger?.log === "function") {
            this.dataSource.logger.log("warn", message, this.rawQueryRunner)
        } else console.warn(message)
    }

    /** Migrations at or below `startAfter` predate the install and are grandfathered. */
    private get versionSafe(): boolean {
        const timestamp = this.migration.timestamp
        return timestamp !== undefined && timestamp <= this.config.startAfter
    }

    isSafe(key?: CheckKey, op?: Operation): boolean {
        if (this.safetyAssured) return true
        // Not bare truthiness: "0" and "false" are non-empty strings, so the natural
        // way to switch this off in a deploy config would instead have disabled every
        // check in the library, silently and permanently.
        if (envFlag(process.env.SAFETY_ASSURED)) return true
        if (this.versionSafe) return true
        if (this.direction === "down" && !this.config.checkDown) return true

        const declared = this.migration.instanceSafetyAssured
        if (declared === true) return true
        if (Array.isArray(declared) && key && declared.includes(key))
            return true

        if (op?.markers?.safetyAssured) return true
        if (key && op?.markers?.disabled?.includes(key)) return true
        return false
    }

    enabled(key: CheckKey): boolean {
        const entry = this.config.enabledChecks.get(key)
        if (!entry) return false
        const startAfter = entry.startAfter ?? this.config.startAfter
        const timestamp = this.migration.timestamp
        return timestamp === undefined || timestamp > startAfter
    }

    private renderContext(op: Operation): RenderContext {
        return { source: op.source, dialect: this.dialect }
    }

    context(
        op: Operation,
        options?: { canIntrospect?: boolean; safeByDefault?: boolean },
    ): CheckContext {
        const config =
            options?.safeByDefault === undefined ||
            options.safeByDefault === this.config.safeByDefault
                ? this.config
                : { ...this.config, safeByDefault: options.safeByDefault }
        return {
            dataSource: this.dataSource,
            config,
            adapter: this.adapter,
            dialect: this.dialect,
            direction: this.direction,
            migration: this.migration,
            queryRunner: this.rawQueryRunner,
            transactionMode: this.transactionMode,
            transactionModeInferred: this.transactionModeInferred,
            inTransaction: this.rawQueryRunner.isTransactionActive,
            introspect: this.introspector as Introspector,
            canIntrospect: options?.canIntrospect ?? true,
            render: this.renderContext(op),
            isNewTable: (table) => this.state.isNewTable(table),
            isNewColumn: (table, column) =>
                this.state.isNewColumn(table, column),
            enabled: (key) => this.enabled(key),
            entityName: (table) => this.entityName(table),
            entityProperty: (table, column) =>
                this.entityProperty(table, column),
        }
    }

    /** Entity class name TypeORM maps to this table, if any. */
    entityName(table: TableRef): string | undefined {
        const metadata = this.dataSource.entityMetadatas?.find(
            (entity) =>
                entity.tableName.toLowerCase() === table.name.toLowerCase(),
        )
        return metadata?.name ?? undefined
    }

    entityProperty(
        table: TableRef,
        column: string,
    ): { entity: string; property: string } | undefined {
        const metadata = this.dataSource.entityMetadatas?.find(
            (entity) =>
                entity.tableName.toLowerCase() === table.name.toLowerCase(),
        )
        if (!metadata) return undefined
        const found = metadata.columns.find(
            (candidate) =>
                candidate.databaseName.toLowerCase() === column.toLowerCase(),
        )
        if (!found) return undefined
        return { entity: metadata.name, property: found.propertyName }
    }

    /** Public so the logger layer can raise the same error from its sync path. */
    errorFor(
        verdict: Extract<CheckVerdict, { type: "unsafe" }>,
    ): UnsafeMigrationError {
        const vars = { ...baseVars(this.migration.name), ...verdict.vars }
        return new UnsafeMigrationError({
            key: verdict.key,
            header: verdict.header ?? headerFor(verdict.key),
            body: renderMessage(verdict.key, vars, this.config),
            migrationName: this.migration.name,
            vars,
        })
    }

    /** One-time session setup, mirroring the gem's `set_timeouts`. */
    /** Lexer behaviour for this session, for the analyzer. */
    lexerOptions(): { ansiQuotes: boolean; noBackslashEscapes: boolean } {
        return this.adapter.lexerOptions()
    }

    async ensureSessionSetup(): Promise<void> {
        if (!this.adapter.supported) return
        // sql_mode governs how the lexer reads quotes and escapes, and parsing is
        // synchronous, so it has to be resolved before the first statement is parsed.
        await this.adapter.warmSessionFacts().catch(() => {})
        if (!this.state.timeoutsSet) {
            this.state.timeoutsSet = true
            try {
                if (this.config.statementTimeout !== null) {
                    await this.adapter.setStatementTimeout(
                        parseDuration(
                            this.config.statementTimeout,
                            "statementTimeout",
                        ),
                    )
                }
                if (this.config.lockTimeout !== null) {
                    await this.adapter.setLockTimeout(
                        parseDuration(this.config.lockTimeout, "lockTimeout"),
                    )
                }
                if (this.config.transactionTimeout !== null) {
                    await this.adapter.setTransactionTimeout(
                        parseDuration(
                            this.config.transactionTimeout,
                            "transactionTimeout",
                        ),
                    )
                }
            } catch (error) {
                this.log(
                    `[strong-migrations] Could not set migration timeouts: ${(error as Error).message}`,
                )
            }
        }

        if (
            !this.state.lockTimeoutChecked &&
            this.config.lockTimeoutLimit !== false
        ) {
            this.state.lockTimeoutChecked = true
            const limit = parseDuration(
                this.config.lockTimeoutLimit,
                "lockTimeoutLimit",
            )
            for (const warning of await this.adapter.lockTimeoutWarnings(limit))
                this.log(warning)
        }
    }

    /**
     * The pipeline. Checks are collected for every operation before anything runs,
     * so a multi-clause statement never executes half of itself, and every problem
     * is reported at once rather than one deploy at a time.
     */
    async perform<T>(
        operations: Operation[],
        run: () => Promise<T>,
    ): Promise<T> {
        if (!this.adapter.supported) return run()

        // Before the empty-operations bail-out: a migration whose first statement is
        // a plain SELECT still needs its lock and statement timeouts applied, and
        // that statement is exactly the one they should already be protecting.
        await this.ensureSessionSetup()
        if (operations.length === 0) return run()

        const errors: UnsafeMigrationError[] = []
        const rewrites: Array<Extract<CheckVerdict, { type: "rewrite" }>> = []

        // A rewrite replaces the original statement wholesale, so it is only valid
        // when the statement produced exactly one operation — you cannot swap one
        // clause of a multi-clause ALTER TABLE. Deciding that here rather than after
        // the fact is what makes it safe: a check told that rewriting is off emits its
        // normal `unsafe` verdict, so the caller gets the actionable error. Discovering
        // it later meant discarding the rewrite and running the original unchecked,
        // which made `safeByDefault: true` strictly less safe than leaving it off.
        const canRewrite = this.config.safeByDefault && operations.length === 1

        for (const op of operations) {
            for (const check of checksFor(op.kind)) {
                // A check with no keys only ever warns (e.g. the partial-parse notice),
                // so it is neither gated by enabledChecks nor silenced by safetyAssured.
                const advisory = check.keys.length === 0
                const relevant = check.keys.filter((key) => this.enabled(key))
                if (!advisory) {
                    if (relevant.length === 0) continue
                    // safeByDefault still rewrites inside safetyAssured — the rewrite is
                    // not a complaint, it is the safe form of the same operation.
                    if (
                        relevant.every((key) => this.isSafe(key, op)) &&
                        !canRewrite
                    )
                        continue
                }

                const verdicts = await check.run(
                    op,
                    this.context(op, { safeByDefault: canRewrite }),
                )
                for (const verdict of verdicts) {
                    if (verdict.type === "warn") {
                        this.log(`[strong-migrations] ${verdict.message}`)
                    } else if (verdict.type === "rewrite") {
                        rewrites.push(verdict)
                    } else if (verdict.type === "unsafe") {
                        if (
                            this.isSafe(verdict.key, op) ||
                            !this.enabled(verdict.key)
                        )
                            continue
                        errors.push(this.errorFor(verdict))
                    }
                }
            }
        }

        if (!this.isSafe()) await this.runCustomChecks(operations)

        if (errors.length === 1) throw errors[0]
        if (errors.length > 1)
            throw new AggregateUnsafeMigrationError(errors, this.migration.name)

        await this.removeInvalidIndexes(operations)

        let result: T
        if (rewrites.length > 0) {
            // Only reachable when `canRewrite` held, i.e. exactly one operation.
            for (const rewrite of rewrites)
                await rewrite.run(this.rawQueryRunner)
            result = undefined as T
        } else {
            result = await runWithRetries(this, run)
        }

        for (const op of operations) {
            this.state.record(op)
            for (const table of operationTables(op))
                this.introspector.forget(table)
        }

        if (this.direction === "up" && this.config.autoAnalyze)
            await this.analyze(operations)

        return result
    }

    private async runCustomChecks(operations: Operation[]): Promise<void> {
        if (this.config.checks.length === 0) return
        const first = operations[0]
        for (const check of this.config.checks) {
            await check({
                operations,
                method: first?.raw.method ?? "query",
                args: first?.raw.args ?? [],
                sql: first?.raw.sql,
                direction: this.direction,
                migrationName: this.migration.name,
                version: this.migration.timestamp,
                dataSource: this.dataSource,
                databaseType: this.dataSource.options.type,
                stop: (message: string, options?: { header?: string }) => {
                    throw new UnsafeMigrationError({
                        key: "custom",
                        header: options?.header ?? HEADERS.custom,
                        body: message,
                        migrationName: this.migration.name,
                    })
                },
            })
        }
    }

    /**
     * A `CREATE INDEX CONCURRENTLY` that fails leaves an invalid index behind, and
     * the rerun then collides with the leftover name. Dropping it first makes the
     * migration idempotent.
     *
     * `REINDEX INDEX CONCURRENTLY` would be the obvious alternative, but on failure
     * it leaves yet another invalid index — so the gem drops and recreates, and so
     * do we.
     */
    private async removeInvalidIndexes(operations: Operation[]): Promise<void> {
        if (!this.config.removeInvalidIndexes) return
        if (this.dialect !== "postgres" || this.direction !== "up") return

        for (const op of operations) {
            if (op.kind !== "createIndex" || !op.name) continue
            const exists = await this.introspector.invalidIndexExists(
                op.name,
                op.table.schema,
            )
            if (exists !== true) continue

            this.log(
                `[strong-migrations] Removing invalid index ${op.name} before recreating it`,
            )
            const qualified = op.table.schema
                ? `${quoteIdent(op.table.schema, "postgres")}.${quoteIdent(op.name, "postgres")}`
                : quoteIdent(op.name, "postgres")
            // DROP INDEX CONCURRENTLY cannot run inside a transaction.
            const concurrently = this.rawQueryRunner.isTransactionActive
                ? ""
                : "CONCURRENTLY "
            this.state.skipRetries = true
            try {
                await this.rawQueryRunner.query(
                    `DROP INDEX ${concurrently}IF EXISTS ${qualified}`,
                )
            } catch (error) {
                this.log(
                    `[strong-migrations] Could not remove invalid index ${op.name}: ${(error as Error).message}`,
                )
            } finally {
                this.state.skipRetries = false
            }
        }
    }

    /** ANALYZE after an index is created, so the planner sees it immediately. */
    private async analyze(operations: Operation[]): Promise<void> {
        for (const op of operations) {
            if (op.kind !== "createIndex") continue
            // MySQL's ANALYZE TABLE commits implicitly, which would silently split the
            // migration's transaction in half.
            if (
                this.dialect !== "postgres" &&
                this.rawQueryRunner.isTransactionActive
            ) {
                this.log(
                    "[strong-migrations] Skipping ANALYZE: it commits implicitly on " +
                        `${this.adapter.name} and this migration is in a transaction.`,
                )
                return
            }
            try {
                await this.adapter.analyzeTable(op.table)
            } catch (error) {
                this.log(
                    `[strong-migrations] ANALYZE failed: ${(error as Error).message}`,
                )
            }
        }
    }
}
