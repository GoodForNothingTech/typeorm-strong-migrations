import { describe, expect, it } from "vitest"
import {
    CHECK_KEYS,
    DEFAULT_DISABLED_KEYS,
    GEM_KEY_ALIASES,
    isCheckKey,
} from "../../src/checks/keys"
import { ALL_CHECKS } from "../../src/checks/registry"
import { defaultEnabledChecks } from "../../src/config"
import { banner } from "../../src/errors"
import { ERROR_MESSAGES, headerFor } from "../../src/messages/error-messages"
import { interpolate, splitMigrationName } from "../../src/messages/format"

/**
 * Structural invariants over the whole message table.
 *
 * These are what keep the per-check snapshots honest: a reword can be accepted with
 * `vitest -u`, but it still has to satisfy every rule here, so a message cannot
 * quietly lose a variable, a banner, or its link to a check.
 */
describe("error messages", () => {
    it("has an entry for every check key and no orphans", () => {
        expect(Object.keys(ERROR_MESSAGES).sort()).toEqual(
            [...CHECK_KEYS].sort(),
        )
    })

    it("renders with the searchable banner", () => {
        const rendered = banner(headerFor("createIndex"), "body")
        expect(rendered).toBe(
            "\n=== Dangerous operation detected #strong_migrations ===\n\nbody\n",
        )
    })

    it("leaves no unfilled placeholder once every variable is supplied", () => {
        for (const key of CHECK_KEYS) {
            const template = ERROR_MESSAGES[key]
            const names = [...template.matchAll(/\{\{(\w+)\}\}/g)].map(
                (match) => match[1]!,
            )
            const vars = Object.fromEntries(
                names.map((name) => [name, `<${name}>`]),
            )
            const rendered = interpolate(template, vars)
            expect(
                rendered,
                `${key} left a placeholder unrendered`,
            ).not.toMatch(/\{\{/)
        }
    })

    it("never emits a stray placeholder when optional variables are omitted", () => {
        for (const key of CHECK_KEYS) {
            expect(interpolate(ERROR_MESSAGES[key], {}), key).not.toMatch(
                /\{\{/,
            )
        }
    })

    it("is not left with ragged blank runs after optional fragments drop out", () => {
        for (const key of CHECK_KEYS) {
            const rendered = interpolate(ERROR_MESSAGES[key], {})
            expect(rendered, key).not.toMatch(/\n{3}/)
            expect(rendered, key).toBe(rendered.trim())
        }
    })

    it("has every key reachable from a check or a documented non-check path", () => {
        // transactionMode is raised by the install-time preflight rather than by a
        // check, because it is a property of the pending set as a whole.
        const RAISED_OUTSIDE_CHECKS = new Set(["transactionMode"])
        const reachable = new Set(ALL_CHECKS.flatMap((check) => check.keys))
        const unreachable = CHECK_KEYS.filter(
            (key) => !reachable.has(key) && !RAISED_OUTSIDE_CHECKS.has(key),
        )
        expect(unreachable).toEqual([])
    })

    it("resolves every gem alias to a real key", () => {
        for (const [alias, target] of Object.entries(GEM_KEY_ALIASES)) {
            const keys = Array.isArray(target) ? target : [target]
            for (const key of keys) {
                expect(isCheckKey(key), `${alias} -> ${key}`).toBe(true)
            }
        }
    })

    it("enables everything except the documented opt-ins", () => {
        const enabled = defaultEnabledChecks()
        for (const key of CHECK_KEYS) {
            expect(enabled.has(key), key).toBe(
                !DEFAULT_DISABLED_KEYS.includes(key),
            )
        }
    })

    /**
     * Any message that tells someone to set `transaction = false` must also tell them
     * to change `migrationsTransactionMode`. TypeORM rejects the override outright
     * under the default "all", so half the advice is worse than none.
     */
    it("always pairs transaction = false with the transaction mode it requires", () => {
        for (const key of CHECK_KEYS) {
            const template = ERROR_MESSAGES[key]
            if (!template.includes("transaction = false")) continue
            expect(template, `${key} recommends transaction = false`).toContain(
                'migrationsTransactionMode: "each"',
            )
        }
    })

    /**
     * TypeORM parses `name.slice(-13)` as a timestamp and throws without one, so a
     * follow-up migration named in a message must be nameable.
     */
    it("gives follow-up migrations a valid, non-colliding name", () => {
        const { baseName, timestamp, nextTimestamp } = splitMigrationName(
            "AddIndex1700000000000",
        )
        expect(baseName).toBe("AddIndex")
        expect(timestamp).toBe(1_700_000_000_000)
        expect(nextTimestamp).toBe("1700000000001")
        expect(nextTimestamp).toMatch(/^\d{13}$/)
    })

    it("copes with a migration name that has no timestamp", () => {
        const { baseName, timestamp, nextTimestamp } =
            splitMigrationName("Whatever")
        expect(baseName).toBe("Whatever")
        expect(timestamp).toBeUndefined()
        expect(nextTimestamp).toMatch(/^\d{13}$/)
    })

    it("assigns the right header to the non-default keys", () => {
        expect(headerFor("createIndexColumns")).toBe("Best practice")
        expect(headerFor("rawQuery")).toBe("Possibly dangerous operation")
        expect(headerFor("transactionMode")).toBe("Configuration problem")
        expect(headerFor("createIndex")).toBe("Dangerous operation detected")
    })
})
