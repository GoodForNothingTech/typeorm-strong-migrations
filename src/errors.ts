import type { CheckKey } from "./checks/keys"

export class StrongMigrationsError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "StrongMigrationsError"
    }
}

/**
 * Thrown when a migration contains an operation a check rejected.
 *
 * `body` is the message without the banner, and `key` is the stable identifier —
 * assert on `key`, not on the text, which is treated as patch-level churn.
 */
export class UnsafeMigrationError extends StrongMigrationsError {
    readonly key: CheckKey | "custom"
    readonly header: string
    readonly body: string
    readonly migrationName: string
    readonly vars: Readonly<Record<string, string>>

    constructor(options: {
        key: CheckKey | "custom"
        header: string
        body: string
        migrationName: string
        vars?: Record<string, string>
    }) {
        super(banner(options.header, options.body))
        this.name = "UnsafeMigrationError"
        this.key = options.key
        this.header = options.header
        this.body = options.body
        this.migrationName = options.migrationName
        this.vars = Object.freeze({ ...(options.vars ?? {}) })
    }
}

/** Raised when several operations in one statement each fail a check. */
export class AggregateUnsafeMigrationError extends StrongMigrationsError {
    readonly errors: readonly UnsafeMigrationError[]
    readonly migrationName: string

    constructor(errors: UnsafeMigrationError[], migrationName: string) {
        super(aggregateBanner(errors))
        this.name = "AggregateUnsafeMigrationError"
        this.errors = Object.freeze([...errors])
        this.migrationName = migrationName
    }
}

export class StrongMigrationsConfigError extends StrongMigrationsError {
    constructor(message: string) {
        super(message)
        this.name = "StrongMigrationsConfigError"
    }
}

export const HEADERS = {
    dangerous: "Dangerous operation detected",
    bestPractice: "Best practice",
    possiblyDangerous: "Possibly dangerous operation",
    custom: "Custom check",
    configuration: "Configuration problem",
} as const

export type Header = (typeof HEADERS)[keyof typeof HEADERS] | (string & {})

/**
 * The gem's framing, kept verbatim down to the hashtag — it is what people search
 * for when an error lands in a deploy log.
 */
export function banner(header: string, message: string): string {
    return `\n=== ${header} #strong_migrations ===\n\n${message}\n`
}

function aggregateBanner(errors: UnsafeMigrationError[]): string {
    if (errors.length === 1) return errors[0]!.message
    const sections = errors
        .map(
            (error, index) =>
                `(${index + 1}/${errors.length}) ${error.header}\n\n${error.body}`,
        )
        .join("\n\n---\n\n")
    return banner(
        `${errors.length} dangerous operations detected`,
        `This statement contains more than one unsafe operation.\n\n${sections}`,
    )
}
