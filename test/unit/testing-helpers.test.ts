import { describe, expect, it } from "vitest"
import { getConfig } from "../../src/index"
import {
    defineMigration,
    resetStrongMigrations,
    withConfig,
    withEnv,
    withStartAfter,
    withTargetVersion,
} from "../../src/testing"

/**
 * Published as `typeorm-strong-migrations/testing`, so these are public API — and
 * four of the six had no caller anywhere, including in our own suite.
 */

describe("defineMigration", () => {
    /**
     * TypeORM parses `name.slice(-13)` as a timestamp and throws without one, which is
     * what makes hand-written fixture classes tedious and `startAfter` awkward to vary.
     */
    it("appends a valid 13-digit timestamp to the class name", () => {
        const Migration = defineMigration("AddIndex", { async up() {} })
        expect(Migration.name).toMatch(/^AddIndex\d{13}$/)
        expect(new Migration().name).toBe(Migration.name)
    })

    it("uses the supplied timestamp so startAfter can be exercised", () => {
        const Migration = defineMigration("Old", {
            timestamp: 1_600_000_000_000,
            async up() {},
        })
        expect(Migration.name).toBe("Old1600000000000")
    })

    it("carries transaction and safetyAssured onto the instance", () => {
        const Migration = defineMigration("Concurrent", {
            transaction: false,
            safetyAssured: ["dropColumn"],
            async up() {},
        })
        const instance = new Migration() as unknown as {
            transaction?: boolean
            safetyAssured?: readonly string[]
        }
        expect(instance.transaction).toBe(false)
        expect(instance.safetyAssured).toEqual(["dropColumn"])
    })

    it("supplies a no-op down when none is given", async () => {
        const Migration = defineMigration("NoDown", { async up() {} })
        await expect(
            new Migration().down(undefined as never),
        ).resolves.toBeUndefined()
    })

    it("runs the body it was given", async () => {
        const seen: string[] = []
        const Migration = defineMigration("Records", {
            async up() {
                seen.push("up")
            },
            async down() {
                seen.push("down")
            },
        })
        const instance = new Migration()
        await instance.up(undefined as never)
        await instance.down(undefined as never)
        expect(seen).toEqual(["up", "down"])
    })
})

describe("config scoping helpers", () => {
    it("restores the previous config afterwards", async () => {
        const before = getConfig().startAfter
        await withConfig({ startAfter: 999 }, () => {
            expect(getConfig().startAfter).toBe(999)
        })
        expect(getConfig().startAfter).toBe(before)
    })

    it("restores even when the body throws", async () => {
        const before = getConfig().startAfter
        await expect(
            withConfig({ startAfter: 999 }, () => {
                throw new Error("boom")
            }),
        ).rejects.toThrow("boom")
        expect(getConfig().startAfter).toBe(before)
    })

    it("returns the body's value", async () => {
        await expect(withConfig({}, () => "result")).resolves.toBe("result")
    })

    it("scopes startAfter and env", async () => {
        await withStartAfter(1234, () => {
            expect(getConfig().startAfter).toBe(1234)
        })
        await withEnv("development", () => {
            expect(getConfig().developerEnv).toBe(true)
        })
    })

    /** targetVersion is dev-only, so this helper has to pin the env as well. */
    it("makes targetVersion actually take effect", async () => {
        await withTargetVersion(18, () => {
            expect(getConfig().targetVersion).toBe(18)
            expect(getConfig().developerEnv).toBe(true)
        })
    })

    it("resets to documented defaults", () => {
        resetStrongMigrations()
        expect(getConfig().startAfter).toBe(0)
        expect(getConfig().safeByDefault).toBe(false)
    })
})
