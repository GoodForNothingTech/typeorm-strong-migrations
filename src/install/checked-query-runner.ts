import type { QueryRunner } from "typeorm"
import {
    INTERCEPTED_METHODS,
    operationsFromTypedCall,
} from "../operations/from-typed"
import { operationsFromSql } from "../operations/from-sql"
import type { Operation } from "../operations/types"
import type { Checker } from "../runtime/checker"
import { currentChecker } from "../runtime/context"

/**
 * Wraps the QueryRunner handed to a migration.
 *
 * The critical detail is the receiver. `Reflect.get(target, prop, target)` and
 * `Reflect.apply(fn, target, args)` mean `this` inside the real method is always
 * the *unwrapped* runner. TypeORM's typed DDL helpers funnel through
 * `BaseQueryRunner.executeQueries`, which calls `this.query(...)`; if `this` were
 * the proxy, a single `addColumn` would be reported twice — once as a typed call
 * and again as raw SQL. Passing the raw target keeps it to exactly one.
 */
export function createCheckedQueryRunner(
    queryRunner: QueryRunner,
    bound: Checker,
): QueryRunner {
    /**
     * Resolved per call rather than captured once. `safetyAssured` works by forking
     * the checker into a new async context; a proxy holding the original reference
     * would keep consulting the un-forked one and reject the very thing the caller
     * just vouched for.
     */
    const active = (): Checker => {
        const store = currentChecker()
        return store && store.dataSource === bound.dataSource ? store : bound
    }

    return new Proxy(queryRunner, {
        get(target, property, _receiver) {
            const value = Reflect.get(target, property, target)
            if (typeof value !== "function" || typeof property !== "string")
                return value
            if (!INTERCEPTED_METHODS.has(property)) return value.bind(target)

            if (property === "query") {
                return (...args: unknown[]) => {
                    const checker = active()
                    const sql = typeof args[0] === "string" ? args[0] : ""
                    const operations = operationsFromSql(
                        sql,
                        checker.dialect,
                        checker.dataSource,
                    )
                    return checker.perform(
                        operations,
                        () =>
                            Reflect.apply(
                                value,
                                target,
                                args,
                            ) as Promise<unknown>,
                    )
                }
            }

            if (property === "sql") {
                return (
                    strings: TemplateStringsArray,
                    ...values: unknown[]
                ) => {
                    const checker = active()
                    const operations = operationsFromSql(
                        reconstructTaggedSql(strings, values, checker.dialect),
                        checker.dialect,
                        checker.dataSource,
                    )
                    return checker.perform(
                        operations,
                        () =>
                            Reflect.apply(value, target, [
                                strings,
                                ...values,
                            ]) as Promise<unknown>,
                    )
                }
            }

            return (...args: unknown[]) => {
                const checker = active()
                const operations: Operation[] =
                    operationsFromTypedCall(property, args, checker.dialect) ??
                    []
                return checker.perform(
                    operations,
                    () =>
                        Reflect.apply(value, target, args) as Promise<unknown>,
                )
            }
        },
    })
}

/**
 * `queryRunner.sql` interpolates values as bound parameters. We only need shape, so
 * substituting placeholders is enough for the analyzer and avoids ever putting a
 * user value into text we might log.
 */
function reconstructTaggedSql(
    strings: TemplateStringsArray,
    values: unknown[],
    dialect: string,
): string {
    return strings.reduce((acc, part, index) => {
        if (index >= values.length) return acc + part
        const placeholder = dialect === "postgres" ? `$${index + 1}` : "?"
        return acc + part + placeholder
    }, "")
}
