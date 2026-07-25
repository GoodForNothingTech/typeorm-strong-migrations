import type { QueryRunner } from "typeorm"
import { state } from "../state"
import type { Checker } from "./checker"

/**
 * AsyncLocalStorage is the source of truth for "which migration is running".
 *
 * A module-level flag would be wrong here, not merely inelegant. With
 * `migrationsRun: true` on a booting server the logger layer fires for every
 * unrelated application query while a migration is in flight; a global flag would
 * run migration checks against application SQL and reject ordinary INSERTs. An
 * async context is invisible to work that did not originate inside the migration.
 *
 * `queryRunner.data` is a secondary index for the one case ALS cannot cover: a
 * callback that crossed a boundary the async context did not follow.
 */
const CHECKER_KEY = Symbol.for("typeorm-strong-migrations.checker")

export function currentChecker(): Checker | undefined {
    return state().als.getStore()
}

export function runWithChecker<T>(
    checker: Checker,
    fn: () => Promise<T>,
): Promise<T> {
    return state().als.run(checker, fn)
}

export function attachToQueryRunner(
    queryRunner: QueryRunner,
    checker: Checker,
): void {
    const data = (queryRunner.data ??= {}) as Record<symbol, unknown>
    data[CHECKER_KEY] = checker
}

/**
 * Identity-checked so a late `finally` from a previous migration cannot clear the
 * current one. Under `transactionMode: "all"` every migration in the batch shares
 * one QueryRunner, so this slot is reused rather than stacked.
 */
export function detachFromQueryRunner(
    queryRunner: QueryRunner,
    checker: Checker,
): void {
    const data = queryRunner.data as Record<symbol, unknown> | undefined
    if (data && data[CHECKER_KEY] === checker) delete data[CHECKER_KEY]
}

export function checkerFromQueryRunner(
    queryRunner: QueryRunner | undefined,
): Checker | undefined {
    const data = queryRunner?.data as Record<symbol, unknown> | undefined
    return data?.[CHECKER_KEY] as Checker | undefined
}

export function activeChecker(queryRunner?: QueryRunner): Checker | undefined {
    return currentChecker() ?? checkerFromQueryRunner(queryRunner)
}
