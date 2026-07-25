import { StrongMigrationsConfigError } from "../errors"

/**
 * The gem writes `10.seconds`. A bare number in JavaScript is ambiguous — seconds
 * in Rails, milliseconds nearly everywhere in Node — so strings carry the unit and
 * are the documented form. A bare number is milliseconds.
 */
export type Duration =
    `${number}ms` | `${number}s` | `${number}m` | `${number}h` | number

const PATTERN = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)\s*$/i

const MULTIPLIER: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
}

/** Returns milliseconds. */
export function parseDuration(value: Duration, optionName: string): number {
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value < 0) {
            throw new StrongMigrationsConfigError(
                `${optionName} must be a non-negative number of milliseconds, got ${String(value)}`,
            )
        }
        return value
    }
    const match = PATTERN.exec(value)
    if (!match) {
        throw new StrongMigrationsConfigError(
            `${optionName} must look like "10s", "500ms", "5m" or "1h", or be a number of milliseconds. Got ${JSON.stringify(value)}`,
        )
    }
    return Number(match[1]) * MULTIPLIER[match[2]!.toLowerCase()]!
}

export function formatSeconds(ms: number): string {
    const seconds = ms / 1000
    return Number.isInteger(seconds)
        ? String(seconds)
        : seconds.toFixed(3).replace(/0+$/, "")
}

/**
 * Postgres reports timeouts as `SHOW lock_timeout` with a unit suffix.
 * Ported from the gem's `timeout_to_sec`.
 */
export function postgresTimeoutToMs(value: string): number | undefined {
    const match = /^\s*(\d+(?:\.\d+)?)\s*(us|ms|s|min|h|d)?\s*$/i.exec(value)
    if (!match) return undefined
    const amount = Number(match[1])
    switch ((match[2] ?? "ms").toLowerCase()) {
        case "us":
            return amount / 1000
        case "ms":
            return amount
        case "s":
            return amount * 1000
        case "min":
            return amount * 60_000
        case "h":
            return amount * 3_600_000
        case "d":
            return amount * 86_400_000
        default:
            return undefined
    }
}
