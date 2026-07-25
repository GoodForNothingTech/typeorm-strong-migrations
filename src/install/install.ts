import type { DataSource, Migration } from "typeorm"
import { createAdapter, resolveServerVersion } from "../adapters/factory"
import type { StrongMigrationsConfig } from "../config"
import { mergeConfig } from "../config"
import { UnsafeMigrationError } from "../errors"
import { headerFor } from "../messages/error-messages"
import { baseVars, renderMessage } from "../messages/format"
import type { InstallRecord } from "../state"
import { state } from "../state"
import { installLoggerLayer, uninstallLoggerLayer } from "./logger-layer"
import { wrapAllMigrations } from "./wrap-migration"

const INSTALLED = Symbol.for("typeorm-strong-migrations.installed")

/**
 * Where `register` publishes the `initialize` it displaced on the prototype.
 * Exported so `register` and this module cannot drift on the key.
 */
export const ORIGINAL_INITIALIZE = Symbol.for(
    "typeorm-strong-migrations.original-initialize",
)

/**
 * The implementation to wrap.
 *
 * With `register` loaded and no own `initialize` on the instance,
 * `dataSource.initialize` resolves up the prototype chain to register's patch —
 * and that patch delegates to the instance property this function is about to
 * create, so wrapping it would make the two call each other until the stack blew.
 * An own property means someone patched this instance deliberately; respect it.
 */
function unpatchedInitialize(dataSource: DataSource): DataSource["initialize"] {
    if (Object.prototype.hasOwnProperty.call(dataSource, "initialize"))
        return dataSource.initialize
    const published = (dataSource as unknown as Record<symbol, unknown>)[
        ORIGINAL_INITIALIZE
    ]
    return typeof published === "function"
        ? (published as DataSource["initialize"])
        : dataSource.initialize
}

type RunMigrationsOptions = {
    transaction?: "all" | "each" | "none"
    fake?: boolean
}

/**
 * Patches a DataSource so its migrations are checked.
 *
 * Three methods are patched rather than one. `initialize` alone is not enough:
 * with `migrationsRun: true` TypeORM runs migrations *inside* `initialize()`
 * (DataSource.ts), so wrapping afterwards would be too late — which is exactly the
 * NestJS `forRoot({ migrationsRun: true })` case. Patching `runMigrations` and
 * `undoLastMigration` also gives us the effective transaction mode, which several
 * messages need to give correct advice.
 *
 * Returns the same instance, so it composes: `installStrongMigrations(new DataSource(...))`.
 */
export function installStrongMigrations(
    dataSource: DataSource,
    config: StrongMigrationsConfig = {},
): DataSource {
    const store = state()
    const existing = store.installs.get(dataSource)

    if (existing) {
        // Re-installing layers on top of what the first install resolved, rather than
        // rebasing on the module singleton — which knows nothing about the options the
        // earlier call passed, so rebasing would silently revert them.
        existing.config = mergeConfig(existing.config, config)
        return dataSource
    }

    const resolved = mergeConfig(store.config, config)

    const record: InstallRecord = {
        config: resolved,
        transactionMode: dataSource.options.migrationsTransactionMode ?? "all",
        transactionModeInferred: true,
    }
    // Check the marker *before* publishing the record. Registering a record whose
    // `uninstall` is never populated would make `uninstallStrongMigrations` a silent
    // no-op while the patches stay live, and would leave the patched closures writing
    // transaction state into a record nobody reads.
    const marked = dataSource as unknown as Record<symbol, unknown>
    if (marked[INSTALLED]) return dataSource

    store.installs.set(dataSource, record)

    Object.defineProperty(dataSource, INSTALLED, {
        value: true,
        enumerable: false,
        configurable: true,
    })

    warnIfTargetVersionIgnored(resolved)

    // Keep the unbound originals for restore so `uninstall` puts back the exact
    // function that was there, and bound copies for calling through.
    const unpatched = {
        initialize: unpatchedInitialize(dataSource),
        runMigrations: dataSource.runMigrations,
        undoLastMigration: dataSource.undoLastMigration,
    }
    const originalInitialize = unpatched.initialize.bind(dataSource)
    const originalRun = unpatched.runMigrations.bind(dataSource)
    const originalUndo = unpatched.undoLastMigration.bind(dataSource)

    dataSource.initialize = async (): Promise<DataSource> => {
        const initialized = await originalInitialize()
        await warmCache(initialized, record)
        wrapAllMigrations(initialized)
        return initialized
    }

    dataSource.runMigrations = async (
        options?: RunMigrationsOptions,
    ): Promise<Migration[]> => {
        await warmCache(dataSource, record)
        record.transactionMode =
            options?.transaction ??
            dataSource.options.migrationsTransactionMode ??
            "all"
        record.transactionModeInferred = false
        wrapAllMigrations(dataSource)
        preflightTransactionMode(dataSource, record)
        return originalRun(options)
    }

    dataSource.undoLastMigration = async (
        options?: RunMigrationsOptions,
    ): Promise<void> => {
        await warmCache(dataSource, record)
        record.transactionMode = options?.transaction ?? "all"
        record.transactionModeInferred = false
        wrapAllMigrations(dataSource)
        return originalUndo(options)
    }

    installLoggerLayer(dataSource)

    record.uninstall = () => {
        dataSource.initialize = unpatched.initialize
        dataSource.runMigrations = unpatched.runMigrations
        dataSource.undoLastMigration = unpatched.undoLastMigration
        uninstallLoggerLayer(dataSource)
        delete marked[INSTALLED]
        store.installs.delete(dataSource)
    }

    // Support installing after initialize(), e.g. from a bootstrap that already
    // connected.
    if (dataSource.isInitialized) {
        void warmCache(dataSource, record).then(() =>
            wrapAllMigrations(dataSource),
        )
    }

    return dataSource
}

export function uninstallStrongMigrations(dataSource: DataSource): void {
    state().installs.get(dataSource)?.uninstall?.()
}

export function isInstalled(dataSource: DataSource): boolean {
    return state().installs.has(dataSource)
}

/**
 * Resolves the server version once, before any migration transaction exists.
 *
 * Under `migrationsTransactionMode: "all"` one transaction spans the whole batch,
 * so after a failure Postgres rejects every subsequent statement — including ours.
 * Reading the version up front means no check has to ask the database at a moment
 * when it cannot answer.
 */
async function warmCache(
    dataSource: DataSource,
    record: InstallRecord,
): Promise<void> {
    if (record.serverVersion !== undefined) return
    if (!dataSource.isInitialized) return
    let runner
    try {
        runner = dataSource.createQueryRunner()
        const adapter = createAdapter(
            dataSource.options.type,
            runner,
            record.config,
        )
        record.serverVersion = await resolveServerVersion(
            dataSource,
            adapter,
            record.config,
        )
    } catch {
        // Version detection is best-effort; an unknown version disables only the
        // version-gated checks.
    } finally {
        if (runner) await runner.release().catch(() => {})
    }
}

/**
 * TypeORM rejects any migration that sets `transaction` — including `true` — while
 * the mode is "all", and its own error says nothing about why. Since our own
 * advice tells people to set `transaction = false`, catching this first and
 * explaining it is the difference between a fix and a dead end.
 */
function preflightTransactionMode(
    dataSource: DataSource,
    record: InstallRecord,
): void {
    if (record.transactionMode !== "all") return
    if (!record.config.enabledChecks.has("transactionMode")) return

    // NOTE: this scans every registered migration, while TypeORM only rejects
    // *pending* ones (MigrationExecutor filters `pendingMigrations`). An
    // already-applied migration declaring `transaction` therefore fails every later
    // `runMigrations()`. Narrowing it needs the executed-migrations list, which is an
    // async lookup this synchronous preflight cannot make.
    const offender = (dataSource.migrations ?? []).find(
        (migration) => migration.transaction !== undefined,
    )
    if (!offender) return

    const name = String(
        offender.name ??
            (offender.constructor as { name?: string }).name ??
            "Migration",
    )
    const vars = {
        ...baseVars(name),
        mode: record.transactionMode,
        declared: String(offender.transaction),
    }
    throw new UnsafeMigrationError({
        key: "transactionMode",
        header: headerFor("transactionMode"),
        body: renderMessage("transactionMode", vars, record.config),
        migrationName: name,
        vars,
    })
}

/**
 * `targetVersion` is honored in development and test only. Someone who sets it in a
 * container with no NODE_ENV would otherwise see it silently ignored, so say so
 * once, and only when it actually matters.
 */
function warnIfTargetVersionIgnored(config: InstallRecord["config"]): void {
    const configured =
        config.targetVersion !== undefined || config.targetSqlMode !== null
    if (!configured || config.developerEnv) return
    if (process.env.NODE_ENV || process.env.STRONG_MIGRATIONS_ENV) return
    console.warn(
        "[strong-migrations] targetVersion is set but NODE_ENV is unset, so the environment " +
            'is assumed to be "production" and targetVersion will be ignored. Set NODE_ENV or ' +
            'STRONG_MIGRATIONS_ENV to "development"/"test", or pass { env: "development" }.',
    )
}
