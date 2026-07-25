import type { DataSource } from "typeorm"
import type { CheckKey, CheckKeyInput } from "./checks/keys"
import {
    CHECK_KEYS,
    DEFAULT_DISABLED_KEYS,
    resolveCheckKeys,
} from "./checks/keys"
import { StrongMigrationsConfigError } from "./errors"
import type { Operation } from "./operations/types"
import type { Duration } from "./util/duration"

export type { Duration }

/** Supported engines. Everything else gets an unsupported-adapter warning and no checks. */
export type SupportedDatabase = "postgres" | "mysql" | "mariadb"

export interface CheckContextForCustomCheck {
    readonly operations: readonly Operation[]
    readonly method: string
    readonly args: readonly unknown[]
    readonly sql?: string
    readonly direction: "up" | "down"
    readonly migrationName: string
    readonly version?: number
    readonly dataSource: DataSource
    readonly databaseType: string
    /** Reject the migration with a custom message. */
    stop(message: string, options?: { header?: string }): never
}

export type CustomCheck = (
    context: CheckContextForCustomCheck,
) => void | Promise<void>

/** What to do with a statement we could not fully interpret. */
export type UnknownSqlBehavior = "error" | "warn" | "ignore"

export interface StrongMigrationsConfig {
    /** Identity for this DataSource, used by `skippedDataSources`. Default: options.database ?? "default". */
    name?: string

    /**
     * Overrides NODE_ENV. Default: STRONG_MIGRATIONS_ENV ?? NODE_ENV ?? "production".
     * Unset means production — if we cannot prove we are in development, checks
     * must not be weakened.
     */
    env?: "development" | "test" | "production" | (string & {})

    /** Migrations at or below this timestamp are treated as safe. 13-digit ms epoch. */
    startAfter?: number

    /** Run ANALYZE on the table after an index is created. */
    autoAnalyze?: boolean

    /** Custom checks, appended to any registered with addCheck(). */
    checks?: CustomCheck[]

    /** Override individual message bodies. Merged over the built-ins. */
    errorMessages?: Partial<Record<CheckKey, string>>

    /**
     * Production server version, honored in development/test only. Key it by
     * database type when you run more than one engine.
     */
    targetVersion?:
        string | number | Partial<Record<SupportedDatabase, string | number>>

    /**
     * Merged over the defaults rather than replacing them — the gem's replace
     * semantics silently drops every other check when you set one key.
     */
    enabledChecks?: Partial<
        Record<CheckKeyInput, boolean | { startAfter?: number }>
    >

    lockTimeout?: Duration | null
    statementTimeout?: Duration | null
    /** Postgres 17+ only; ignored elsewhere. */
    transactionTimeout?: Duration | null

    /** Warn (never raise) when the session lock timeout exceeds this. */
    lockTimeoutLimit?: Duration | false

    /** Run checks when migrating down. */
    checkDown?: boolean

    /**
     * Rewrite unsafe operations into their safe form. Requires
     * migrationsTransactionMode "each" or "none".
     */
    safeByDefault?: boolean

    /** MySQL/MariaDB sql_mode to assume. Development/test only. */
    targetSqlMode?: string | null

    /** Retry statements that hit a lock timeout. No-op inside a transaction. */
    lockTimeoutRetries?: number
    lockTimeoutRetryDelay?: Duration

    /** Skip every check for DataSources whose `name` is listed. */
    skippedDataSources?: string[]

    /** Postgres: drop a leftover invalid index before recreating it. */
    removeInvalidIndexes?: boolean

    /** DDL-shaped SQL the analyzer could not interpret. */
    unknownSql?: UnknownSqlBehavior
    /** A statement parsed with an unmodeled tail clause. */
    partialSql?: UnknownSqlBehavior

    /** Where warnings go. Defaults to the DataSource logger, else console.warn. */
    logger?: (level: "warn" | "info", message: string) => void
}

export interface ResolvedConfig {
    name?: string
    env: string
    developerEnv: boolean
    startAfter: number
    autoAnalyze: boolean
    checks: CustomCheck[]
    errorMessages: Partial<Record<CheckKey, string>>
    targetVersion?:
        string | number | Partial<Record<SupportedDatabase, string | number>>
    enabledChecks: Map<CheckKey, { startAfter?: number }>
    lockTimeout: Duration | null
    statementTimeout: Duration | null
    transactionTimeout: Duration | null
    lockTimeoutLimit: Duration | false
    checkDown: boolean
    safeByDefault: boolean
    targetSqlMode: string | null
    lockTimeoutRetries: number
    lockTimeoutRetryDelay: Duration
    skippedDataSources: string[]
    removeInvalidIndexes: boolean
    unknownSql: UnknownSqlBehavior
    partialSql: UnknownSqlBehavior
    logger?: (level: "warn" | "info", message: string) => void
}

export function currentEnv(explicit?: string): string {
    return (
        explicit ??
        process.env.STRONG_MIGRATIONS_ENV ??
        process.env.NODE_ENV ??
        "production"
    )
}

export function isDeveloperEnv(env: string): boolean {
    return env === "development" || env === "test"
}

export function defaultEnabledChecks(): Map<CheckKey, { startAfter?: number }> {
    const map = new Map<CheckKey, { startAfter?: number }>()
    for (const key of CHECK_KEYS) {
        if (!DEFAULT_DISABLED_KEYS.includes(key)) map.set(key, {})
    }
    return map
}

/** Base config with everything at its documented default. */
export function baseConfig(): ResolvedConfig {
    const env = currentEnv()
    const developerEnv = isDeveloperEnv(env)
    return {
        env,
        developerEnv,
        startAfter: 0,
        autoAnalyze: false,
        checks: [],
        errorMessages: {},
        enabledChecks: defaultEnabledChecks(),
        lockTimeout: null,
        statementTimeout: null,
        transactionTimeout: null,
        // The gem's default: warn-only, and off in development where long local
        // migrations are normal.
        lockTimeoutLimit: developerEnv ? false : "10s",
        checkDown: false,
        safeByDefault: false,
        targetSqlMode: null,
        lockTimeoutRetries: 0,
        lockTimeoutRetryDelay: "10s",
        skippedDataSources: [],
        removeInvalidIndexes: false,
        unknownSql: "error",
        partialSql: "warn",
    }
}

/** Layers `partial` over `base`, resolving env-dependent defaults last. */
export function mergeConfig(
    base: ResolvedConfig,
    partial: StrongMigrationsConfig,
): ResolvedConfig {
    const envExplicitlySet = partial.env !== undefined
    const env = envExplicitlySet ? currentEnv(partial.env) : base.env
    const developerEnv = isDeveloperEnv(env)

    const enabledChecks = new Map(base.enabledChecks)
    if (partial.enabledChecks) {
        for (const [rawKey, value] of Object.entries(partial.enabledChecks)) {
            const keys = resolveCheckKeys(rawKey)
            if (keys.length === 0) {
                throw new StrongMigrationsConfigError(
                    `Unknown check key ${JSON.stringify(rawKey)} in enabledChecks. See CHECK_KEYS for the full list.`,
                )
            }
            for (const key of keys) {
                if (value === false) enabledChecks.delete(key)
                else if (value === true) enabledChecks.set(key, {})
                else enabledChecks.set(key, { ...value })
            }
        }
    }

    // Normalize while validating. Gem aliases are accepted everywhere a key is, but
    // `messageTemplate` looks the override up by canonical CheckKey — so storing the
    // raw alias let `errorMessages: { add_index: "..." }` validate cleanly and then
    // never render, which is worse than rejecting it.
    let errorMessages: Partial<Record<CheckKey, string>> | undefined
    if (partial.errorMessages) {
        errorMessages = {}
        for (const [key, message] of Object.entries(partial.errorMessages)) {
            const resolved = resolveCheckKeys(key)
            if (resolved.length === 0) {
                throw new StrongMigrationsConfigError(
                    `Unknown check key ${JSON.stringify(key)} in errorMessages.`,
                )
            }
            for (const canonical of resolved) errorMessages[canonical] = message
        }
    }

    const pick = <K extends keyof ResolvedConfig>(
        key: K,
        value: ResolvedConfig[K] | undefined,
    ): ResolvedConfig[K] => (value === undefined ? base[key] : value)

    return {
        name: partial.name ?? base.name,
        env,
        developerEnv,
        startAfter: pick("startAfter", partial.startAfter),
        autoAnalyze: pick("autoAnalyze", partial.autoAnalyze),
        checks: partial.checks
            ? [...base.checks, ...partial.checks]
            : base.checks,
        errorMessages: { ...base.errorMessages, ...errorMessages },
        targetVersion: partial.targetVersion ?? base.targetVersion,
        enabledChecks,
        lockTimeout:
            partial.lockTimeout === undefined
                ? base.lockTimeout
                : partial.lockTimeout,
        statementTimeout:
            partial.statementTimeout === undefined
                ? base.statementTimeout
                : partial.statementTimeout,
        transactionTimeout:
            partial.transactionTimeout === undefined
                ? base.transactionTimeout
                : partial.transactionTimeout,
        // Re-derive when env changed and the caller did not pin the limit.
        lockTimeoutLimit:
            partial.lockTimeoutLimit !== undefined
                ? partial.lockTimeoutLimit
                : envExplicitlySet
                  ? developerEnv
                      ? false
                      : "10s"
                  : base.lockTimeoutLimit,
        checkDown: pick("checkDown", partial.checkDown),
        safeByDefault: pick("safeByDefault", partial.safeByDefault),
        targetSqlMode:
            partial.targetSqlMode === undefined
                ? base.targetSqlMode
                : partial.targetSqlMode,
        lockTimeoutRetries: pick(
            "lockTimeoutRetries",
            partial.lockTimeoutRetries,
        ),
        lockTimeoutRetryDelay: pick(
            "lockTimeoutRetryDelay",
            partial.lockTimeoutRetryDelay,
        ),
        skippedDataSources: partial.skippedDataSources
            ? [
                  ...new Set([
                      ...base.skippedDataSources,
                      ...partial.skippedDataSources,
                  ]),
              ]
            : base.skippedDataSources,
        removeInvalidIndexes: pick(
            "removeInvalidIndexes",
            partial.removeInvalidIndexes,
        ),
        unknownSql: pick("unknownSql", partial.unknownSql),
        partialSql: pick("partialSql", partial.partialSql),
        logger: partial.logger ?? base.logger,
    }
}

/**
 * Resolves the effective target version for an engine. Honored in development and
 * test only; production always uses the real server version.
 */
export function resolvedTargetVersion(
    config: ResolvedConfig,
    database: SupportedDatabase,
): string | undefined {
    if (!config.developerEnv || config.targetVersion === undefined)
        return undefined
    const value = config.targetVersion
    if (typeof value === "string" || typeof value === "number")
        return String(value)
    const forDatabase = value[database]
    return forDatabase === undefined ? undefined : String(forDatabase)
}

/** Typed identity function, for users who keep config in its own module. */
export function defineStrongMigrationsConfig(
    config: StrongMigrationsConfig,
): StrongMigrationsConfig {
    return config
}
