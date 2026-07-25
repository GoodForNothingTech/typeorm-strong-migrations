import type { Checker } from "./checker"
import { parseDuration } from "../util/duration"

/**
 * Postgres raises 55P03 (lock_not_available) when `lock_timeout` fires. 57014 is
 * `statement_timeout` and must NOT be retried — the statement itself was too slow,
 * so retrying just burns another timeout.
 */
const PG_LOCK_NOT_AVAILABLE = "55P03"
const MYSQL_LOCK_WAIT_TIMEOUT = 1205

export function isLockTimeout(error: unknown): boolean {
    if (typeof error !== "object" || error === null) return false
    const candidate = error as {
        code?: unknown
        errno?: unknown
        message?: unknown
    }
    if (candidate.code === PG_LOCK_NOT_AVAILABLE) return true
    if (candidate.errno === MYSQL_LOCK_WAIT_TIMEOUT) return true
    if (candidate.code === "ER_LOCK_WAIT_TIMEOUT") return true
    return (
        typeof candidate.message === "string" &&
        /lock wait timeout|lock timeout/i.test(candidate.message)
    )
}

/**
 * Statement-level retry only.
 *
 * Retrying inside a transaction is pointless — Postgres has already aborted it and
 * every subsequent statement fails until rollback — so this is a no-op there, the
 * same restriction the gem has. Whole-migration retry would require owning the
 * transaction around `up()`, which `MigrationExecutor` does.
 */
export async function runWithRetries<T>(
    checker: Checker,
    run: () => Promise<T>,
): Promise<T> {
    const retries = checker.config.lockTimeoutRetries
    const eligible =
        retries > 0 &&
        !checker.rawQueryRunner.isTransactionActive &&
        !checker.state.skipRetries
    if (!eligible) return run()

    const delay = parseDuration(
        checker.config.lockTimeoutRetryDelay,
        "lockTimeoutRetryDelay",
    )
    let attempt = 0
    for (;;) {
        try {
            return await run()
        } catch (error) {
            if (attempt >= retries || !isLockTimeout(error)) throw error
            attempt += 1
            const seconds = Math.round(delay / 1000)
            console.warn(
                `[strong-migrations] Lock timeout. Retrying in ${seconds} seconds... ` +
                    `(attempt ${attempt} of ${retries})`,
            )
            await new Promise((resolve) => setTimeout(resolve, delay))
        }
    }
}
