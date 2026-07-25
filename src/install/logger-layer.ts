import type { DataSource, Logger, LoggerOptions, QueryRunner } from "typeorm"
import { operationsFromSql } from "../operations/from-sql"
import type { Operation } from "../operations/types"
import { checksFor } from "../checks/registry"
import { activeChecker } from "../runtime/context"

const WRAPPED = Symbol.for("typeorm-strong-migrations.logger")

/**
 * A secondary net for SQL that reaches the database without passing through the
 * wrapped QueryRunner — a `dataSource.query()` inside a migration, or a second
 * runner created by the migration itself.
 *
 * `logQuery` runs synchronously immediately before execution in every driver and
 * can veto by throwing, so it is the only hook with this reach. The cost is that it
 * cannot await, so checks needing introspection are skipped here; those still run
 * on the primary path.
 */
class StrongMigrationsLogger implements Logger {
    private resolved: Logger | undefined

    constructor(
        private readonly dataSource: DataSource,
        private readonly delegateOption: LoggerOptions | Logger | undefined,
        readonly previousLogger: Logger | undefined,
    ) {}

    /**
     * Built lazily. The CLI calls `setOptions({ logging: [...] })` *after* the
     * DataSource is constructed; resolving the inner logger eagerly would capture
     * the pre-CLI logging config and silently drop the query logging the user asked
     * for.
     */
    private delegate(): Logger {
        if (!this.resolved) {
            this.resolved = buildDelegate(
                this.dataSource,
                this.delegateOption,
                this.previousLogger,
            )
        }
        return this.resolved
    }

    logQuery(
        query: string,
        parameters?: unknown[],
        queryRunner?: QueryRunner,
    ): void {
        this.inspect(query, queryRunner)
        this.delegate().logQuery(query, parameters as any[], queryRunner)
    }

    private inspect(query: string, queryRunner?: QueryRunner): void {
        const checker = activeChecker(queryRunner)
        if (!checker) return
        // Our own introspection must not be linted, or every check would recurse.
        if (checker.introspecting) return
        // The primary path already reported anything that came through the wrapped
        // runner; only unowned traffic reaches here.
        if (queryRunner === checker.rawQueryRunner) return

        let operations: Operation[]
        try {
            operations = operationsFromSql(
                query,
                checker.dialect,
                checker.dataSource,
            )
        } catch {
            return
        }

        for (const op of operations) {
            for (const check of checksFor(op.kind)) {
                if (check.needsIntrospection) continue
                if (check.keys.length > 0) {
                    // Gate on `enabled` as the primary path does. Without it a
                    // disabled check still ran, and `assertSafeByDefaultUsable` could
                    // throw a config error out of `logQuery` for a check the user had
                    // switched off.
                    const relevant = check.keys.filter((key) =>
                        checker.enabled(key),
                    )
                    if (relevant.length === 0) continue
                    if (relevant.every((key) => checker.isSafe(key, op)))
                        continue
                }
                // This path cannot await, so it can never apply a rewrite. Asking for
                // one anyway meant the check returned `rewrite` instead of `unsafe`,
                // the loop below dropped it, and the unsafe statement ran unreported.
                const verdicts = check.run(
                    op,
                    checker.context(op, {
                        canIntrospect: false,
                        safeByDefault: false,
                    }),
                )
                // Only synchronous checks can veto from here.
                if (Array.isArray(verdicts)) {
                    for (const verdict of verdicts) {
                        if (verdict.type !== "unsafe") continue
                        if (
                            !checker.enabled(verdict.key) ||
                            checker.isSafe(verdict.key, op)
                        )
                            continue
                        throw checker.errorFor(verdict)
                    }
                }
            }
        }
    }

    logQueryError(
        error: string | Error,
        query: string,
        parameters?: unknown[],
        queryRunner?: QueryRunner,
    ): void {
        this.delegate().logQueryError(
            error,
            query,
            parameters as any[],
            queryRunner,
        )
    }

    logQuerySlow(
        time: number,
        query: string,
        parameters?: unknown[],
        queryRunner?: QueryRunner,
    ): void {
        this.delegate().logQuerySlow(
            time,
            query,
            parameters as any[],
            queryRunner,
        )
    }

    logSchemaBuild(message: string, queryRunner?: QueryRunner): void {
        this.delegate().logSchemaBuild(message, queryRunner)
    }

    logMigration(message: string, queryRunner?: QueryRunner): void {
        this.delegate().logMigration(message, queryRunner)
    }

    log(
        level: "log" | "info" | "warn",
        message: unknown,
        queryRunner?: QueryRunner,
    ): void {
        this.delegate().log(level, message, queryRunner)
    }
}

function buildDelegate(
    dataSource: DataSource,
    option: LoggerOptions | Logger | undefined,
    previous: Logger | undefined,
): Logger {
    if (option && typeof option === "object" && "logQuery" in option)
        return option as Logger
    if (previous) return previous
    return noopLogger()
}

function noopLogger(): Logger {
    const noop = (): void => {}
    return {
        logQuery: noop,
        logQueryError: noop,
        logQuerySlow: noop,
        logSchemaBuild: noop,
        logMigration: noop,
        log: noop,
    }
}

/**
 * Set on both `dataSource.logger` and `dataSource.options.logger`.
 *
 * The CLI's `setOptions({ logging: [...] })` rebuilds `dataSource.logger` from
 * `options.logger ?? this.options.logger`, so a wrapper installed only on the
 * instance field is discarded the moment `typeorm migration:run` starts. Writing it
 * to options too is what makes this survive the CLI.
 */
export function installLoggerLayer(dataSource: DataSource): void {
    const marked = dataSource as unknown as Record<symbol, unknown>
    if (marked[WRAPPED]) return

    const previous = dataSource.logger
    const option = (dataSource.options as { logger?: LoggerOptions | Logger })
        .logger
    const wrapper = new StrongMigrationsLogger(dataSource, option, previous)

    dataSource.logger = wrapper
    ;(dataSource.options as { logger?: unknown }).logger = wrapper
    Object.defineProperty(dataSource, WRAPPED, {
        value: { previous, option },
        enumerable: false,
        configurable: true,
    })
}

export function uninstallLoggerLayer(dataSource: DataSource): void {
    const marked = dataSource as unknown as Record<symbol, unknown>
    const saved = marked[WRAPPED] as
        { previous?: Logger; option?: unknown } | undefined
    if (!saved) return
    // Unconditional: guarding on a truthy `previous` left our wrapper installed when
    // there had been no prior logger, and since the marker is deleted anyway the next
    // install would capture that wrapper as `previous` and nest a second one — every
    // install/uninstall cycle adding a layer that inspects each query again.
    dataSource.logger = saved.previous as Logger
    ;(dataSource.options as { logger?: unknown }).logger = saved.option
    delete marked[WRAPPED]
}
