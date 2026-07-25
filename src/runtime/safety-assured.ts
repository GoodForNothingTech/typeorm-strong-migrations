import { resolveCheckKeys } from "../checks/keys"
import {
    attachToQueryRunner,
    currentChecker,
    detachFromQueryRunner,
    runWithChecker,
} from "./context"

/**
 * The escape hatch, as a scoped async fork rather than a mutable flag.
 *
 * Ruby toggles a class variable and restores it in an `ensure`. In JavaScript that
 * is a real correctness bug: between `flag = true` and the `await` completing,
 * anything else running in the same process observes the relaxed flag. Forking the
 * async context confines it to this call tree.
 *
 * Outside a migration it is a plain pass-through.
 */
export async function safetyAssured<T>(
    fn: () => T | PromiseLike<T>,
): Promise<T> {
    const checker = currentChecker()
    if (!checker) return await fn()

    const forked = checker.fork({ safetyAssured: true })
    // Keep the QueryRunner-attached fallback consistent with the async context, so
    // the logger layer sees the same verdict.
    attachToQueryRunner(checker.rawQueryRunner, forked)
    try {
        return await runWithChecker(forked, async () => await fn())
    } finally {
        detachFromQueryRunner(checker.rawQueryRunner, forked)
        attachToQueryRunner(checker.rawQueryRunner, checker)
    }
}

const MARKER = "/* strong-migrations:safety-assured */"

/**
 * Tags a single statement as reviewed.
 *
 * A marker comment rather than an extra `query()` argument: TypeORM already uses
 * the third parameter for `useStructuredResult`, and a comment survives every
 * layer, including the logger, which only ever sees the SQL string.
 */
export function assured(
    strings: TemplateStringsArray,
    ...values: unknown[]
): string {
    const sql = strings.reduce(
        (acc, part, index) =>
            acc + part + (index < values.length ? String(values[index]) : ""),
        "",
    )
    return `${MARKER} ${sql}`
}

export function hasSafetyAssuredMarker(sql: string): boolean {
    return sql.includes("strong-migrations:safety-assured")
}

const DISABLE_PATTERN = /strong-migrations:disable=([A-Za-z0-9_,]+)/

export function disabledKeysFromSql(sql: string): string[] | undefined {
    const match = DISABLE_PATTERN.exec(sql)
    if (!match) return undefined
    // Resolve through the alias table, as every other key entry point does. The raw
    // split was compared against canonical keys, so `disable=add_index` — the gem
    // spelling this package documents as interchangeable — silently suppressed
    // nothing and the migration still failed.
    return match[1]!
        .split(",")
        .filter(Boolean)
        .flatMap((key) => {
            const resolved = resolveCheckKeys(key.trim())
            return resolved.length > 0 ? resolved : [key.trim()]
        })
}

export function hasIgnoreMarker(sql: string): boolean {
    return sql.includes("strong-migrations:ignore")
}
