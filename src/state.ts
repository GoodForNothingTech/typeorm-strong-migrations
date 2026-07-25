import { AsyncLocalStorage } from "node:async_hooks"
import type { DataSource } from "typeorm"
import type { ResolvedConfig } from "./config"
import { baseConfig } from "./config"
import type { Checker } from "./runtime/checker"

/**
 * We ship dual CJS/ESM. A consumer that resolves both copies would otherwise get
 * two config singletons and two AsyncLocalStorage instances, which would silently
 * break `safetyAssured` — the flag would be set in one store and read from the
 * other. Anchoring state on a well-known global symbol makes a double-load
 * harmless.
 */
const STATE_KEY = Symbol.for("typeorm-strong-migrations.state@1")

export interface InstallRecord {
    config: ResolvedConfig
    /** Resolved once at install, outside any transaction. See adapters/factory. */
    serverVersion?: string
    /** Captured when runMigrations is called; inferred from options otherwise. */
    transactionMode: "all" | "each" | "none"
    transactionModeInferred: boolean
    /** Restores the patched DataSource methods. */
    uninstall?: () => void
}

export interface GlobalState {
    config: ResolvedConfig
    als: AsyncLocalStorage<Checker>
    /** Per-DataSource state, keyed by identity so multiple DataSources stay isolated. */
    installs: WeakMap<DataSource, InstallRecord>
    /** One-time warnings, keyed by an arbitrary dedupe string. */
    warned: Set<string>
}

function create(): GlobalState {
    return {
        config: baseConfig(),
        als: new AsyncLocalStorage<Checker>(),
        installs: new WeakMap(),
        warned: new Set(),
    }
}

export function state(): GlobalState {
    const globals = globalThis as Record<symbol, unknown>
    let current = globals[STATE_KEY] as GlobalState | undefined
    if (!current) {
        current = create()
        globals[STATE_KEY] = current
    }
    return current
}

/** Test-only. Documented as such; resets the module singleton between cases. */
export function resetState(): void {
    const globals = globalThis as Record<symbol, unknown>
    globals[STATE_KEY] = create()
}

export function warnOnce(
    key: string,
    message: string,
    log?: (m: string) => void,
): void {
    const { warned } = state()
    if (warned.has(key)) return
    warned.add(key)
    if (log) log(message)
    else console.warn(message)
}
