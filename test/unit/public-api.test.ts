import { describe, expect, it } from "vitest"
import * as api from "../../src/index"
import * as testing from "../../src/testing"

/**
 * Nothing imported the public barrel, so a renamed or dropped export would not have
 * failed CI — the package's actual contract was untested.
 *
 * This is a change-detector on purpose: the list is the contract. Adding an export
 * means adding it here; removing one means deciding it is a breaking change.
 */

const EXPECTED_EXPORTS = [
    // install
    "installStrongMigrations",
    "uninstallStrongMigrations",
    "isInstalled",
    // escape hatch
    "safetyAssured",
    "assured",
    // config
    "defineStrongMigrationsConfig",
    "configure",
    "getConfig",
    "resetConfig",
    "addCheck",
    "enableCheck",
    "disableCheck",
    "isCheckEnabled",
    "skipDataSource",
    // errors
    "StrongMigrationsError",
    "UnsafeMigrationError",
    "AggregateUnsafeMigrationError",
    "StrongMigrationsConfigError",
    "HEADERS",
    // checks
    "CHECK_KEYS",
    "GEM_KEY_ALIASES",
    "DEFAULT_DISABLED_KEYS",
    "isCheckKey",
    // messages
    "ERROR_MESSAGES",
    "headerFor",
    "renderMessage",
    // analyzer
    "analyzeSql",
    "classify",
    "isBookkeeping",
    "bookkeepingConfig",
    // lint
    "lintSql",
    "lintFiles",
].sort()

describe("public API", () => {
    it("exports exactly the documented surface", () => {
        expect(Object.keys(api).sort()).toEqual(EXPECTED_EXPORTS)
    })

    it("exports functions where functions are expected", () => {
        for (const name of [
            "installStrongMigrations",
            "safetyAssured",
            "configure",
            "analyzeSql",
            "lintSql",
        ]) {
            expect(typeof (api as Record<string, unknown>)[name], name).toBe(
                "function",
            )
        }
    })

    /**
     * These are error *classes*, so `instanceof` must work for consumers who catch
     * them — a plain object with the right shape would pass a typeof check.
     */
    it("exports real error classes", () => {
        const error = new api.UnsafeMigrationError({
            key: "createIndex",
            header: "Dangerous operation detected",
            body: "body",
            migrationName: "Test1700000000000",
        })
        expect(error).toBeInstanceOf(api.StrongMigrationsError)
        expect(error).toBeInstanceOf(Error)
        expect(error.key).toBe("createIndex")
    })

    it("does not export an error it can never throw", () => {
        // UnsupportedVersionError was exported but unthrowable: the only function that
        // raised it was never called. Minimum versions now warn instead.
        expect("UnsupportedVersionError" in api).toBe(false)
    })

    it("exports every check key with a message", () => {
        for (const key of api.CHECK_KEYS) {
            expect(api.ERROR_MESSAGES[key], key).toBeTruthy()
            expect(typeof api.headerFor(key), key).toBe("string")
        }
    })

    it("exposes the testing helpers on their own subpath", () => {
        expect(Object.keys(testing).sort()).toEqual(
            [
                "defineMigration",
                "withConfig",
                "withStartAfter",
                "withEnv",
                "withTargetVersion",
                "resetStrongMigrations",
            ].sort(),
        )
    })
})
