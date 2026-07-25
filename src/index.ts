import type { CheckKeyInput } from "./checks/keys"
import { resolveCheckKeys } from "./checks/keys"
import type { CustomCheck, StrongMigrationsConfig } from "./config"
import { mergeConfig, baseConfig } from "./config"
import { StrongMigrationsConfigError } from "./errors"
import { state } from "./state"

// ── install ──────────────────────────────────────────────────────────────────
export {
    installStrongMigrations,
    uninstallStrongMigrations,
    isInstalled,
} from "./install/install"

// ── escape hatch ─────────────────────────────────────────────────────────────
export { safetyAssured, assured } from "./runtime/safety-assured"

// ── config ───────────────────────────────────────────────────────────────────
export { defineStrongMigrationsConfig } from "./config"
export type {
    StrongMigrationsConfig,
    ResolvedConfig,
    CustomCheck,
    CheckContextForCustomCheck,
    SupportedDatabase,
    UnknownSqlBehavior,
    Duration,
} from "./config"

// ── errors ───────────────────────────────────────────────────────────────────
export {
    StrongMigrationsError,
    UnsafeMigrationError,
    AggregateUnsafeMigrationError,
    StrongMigrationsConfigError,
    HEADERS,
} from "./errors"

// ── checks ───────────────────────────────────────────────────────────────────
export {
    CHECK_KEYS,
    GEM_KEY_ALIASES,
    DEFAULT_DISABLED_KEYS,
    isCheckKey,
} from "./checks/keys"
export type { CheckKey, CheckKeyInput } from "./checks/keys"
export type {
    Check,
    CheckContext,
    CheckVerdict,
    MigrationMeta,
} from "./checks/types"

// ── messages ─────────────────────────────────────────────────────────────────
export { ERROR_MESSAGES, headerFor } from "./messages/error-messages"
export { renderMessage } from "./messages/format"

// ── analyzer (also used by the CLI) ──────────────────────────────────────────
export { analyzeSql } from "./sql/analyze"
export { classify, isBookkeeping, bookkeepingConfig } from "./sql/classify"
export type { StatementClass, BookkeepingConfig } from "./sql/classify"
export type {
    Operation,
    OperationKind,
    Dialect,
    TableRef,
    ColumnSpec,
    SqlType,
} from "./operations/types"

// ── lint ─────────────────────────────────────────────────────────────────────
export { lintSql, lintFiles } from "./lint"
export type { LintFinding, LintResult } from "./lint"

/**
 * Module-level configuration. Applied beneath any per-install config, so
 * `installStrongMigrations(ds, { ... })` still wins for that DataSource.
 */
export function configure(config: StrongMigrationsConfig): void {
    const store = state()
    store.config = mergeConfig(store.config, config)
}

export function getConfig(): ReturnType<typeof baseConfig> {
    return state().config
}

/** Test-only: restores defaults and clears per-DataSource state. */
export function resetConfig(): void {
    state().config = baseConfig()
    state().warned.clear()
}

export function addCheck(check: CustomCheck): void {
    state().config.checks.push(check)
}

export function enableCheck(
    key: CheckKeyInput,
    options: { startAfter?: number } = {},
): void {
    const keys = resolveKeysOrThrow(key)
    for (const resolved of keys)
        state().config.enabledChecks.set(resolved, { ...options })
}

export function disableCheck(key: CheckKeyInput): void {
    for (const resolved of resolveKeysOrThrow(key))
        state().config.enabledChecks.delete(resolved)
}

export function isCheckEnabled(key: CheckKeyInput, version?: number): boolean {
    const keys = resolveCheckKeys(key)
    return keys.some((resolved) => {
        const entry = state().config.enabledChecks.get(resolved)
        if (!entry) return false
        const startAfter = entry.startAfter ?? state().config.startAfter
        return version === undefined || version > startAfter
    })
}

export function skipDataSource(name: string): void {
    const list = state().config.skippedDataSources
    if (!list.includes(name)) list.push(name)
}

function resolveKeysOrThrow(
    key: CheckKeyInput,
): ReturnType<typeof resolveCheckKeys> {
    const keys = resolveCheckKeys(key)
    if (keys.length === 0) {
        throw new StrongMigrationsConfigError(
            `Unknown check key ${JSON.stringify(key)}. See CHECK_KEYS for the full list.`,
        )
    }
    return keys
}
