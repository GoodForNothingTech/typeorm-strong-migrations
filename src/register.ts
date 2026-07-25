import { DataSource } from "typeorm"
import { installStrongMigrations, ORIGINAL_INITIALIZE } from "./install/install"
import { state } from "./state"

/**
 * Side-effect entry: `import "typeorm-strong-migrations/register"`, or
 * `node -r typeorm-strong-migrations/register`.
 *
 * Patches `DataSource.prototype.initialize` so every DataSource is installed on
 * first use, for codebases where editing the data-source file is awkward. The
 * explicit `installStrongMigrations(dataSource, config)` call is preferred — it is
 * visible at the call site and takes per-DataSource config, which this cannot.
 *
 * `DataSource.prototype` is patched rather than `MigrationExecutor`'s: it is the
 * more stable surface, and it avoids the dual-package hazard of needing to match a
 * specific class identity.
 */
const PATCHED = Symbol.for("typeorm-strong-migrations.prototype-patched")

const marked = DataSource.prototype as unknown as Record<symbol, unknown>
if (!marked[PATCHED]) {
    Object.defineProperty(DataSource.prototype, PATCHED, {
        value: true,
        enumerable: false,
        configurable: true,
    })

    const originalInitialize = DataSource.prototype.initialize

    // Publish the implementation this patch displaces. `install` wraps whatever
    // `dataSource.initialize` resolves to, which — with no own property on the
    // instance — is this patch; wrapping a patch that then delegates back into the
    // wrapper recurses until the stack blows. Reading it off the instance works
    // through the prototype chain, so `install` needs no reference to the class.
    Object.defineProperty(DataSource.prototype, ORIGINAL_INITIALIZE, {
        value: originalInitialize,
        enumerable: false,
        configurable: true,
    })

    DataSource.prototype.initialize = async function initialize(
        this: DataSource,
    ) {
        // No per-DataSource config here — install layers the module singleton
        // underneath, which is the only configuration this entry point can see.
        if (!state().installs.has(this)) installStrongMigrations(this)
        // Reached only when the instance has no own `initialize`, so consult the
        // descriptor rather than `this.initialize` (which would find this patch
        // again). If install patched the instance, run its wrapper; if it declined,
        // run the real implementation.
        const patched = Object.getOwnPropertyDescriptor(this, "initialize")
            ?.value as (() => Promise<DataSource>) | undefined
        return patched ? patched.call(this) : originalInitialize.call(this)
    }
}
