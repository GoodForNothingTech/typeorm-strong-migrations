import { describe, expect, it } from "vitest"
import type { CheckContextForCustomCheck } from "../../src/config"
import { safetyAssured } from "../../src/runtime/safety-assured"
import { runMigration } from "../helpers/assertions"

/**
 * The single subtlest thing in the interception layer.
 *
 * TypeORM's typed DDL helpers all funnel through `BaseQueryRunner.executeQueries`,
 * which calls `this.query(...)`. The proxy therefore has to pass the *raw* runner
 * as the receiver (`Reflect.get(target, prop, target)` /
 * `Reflect.apply(fn, target, args)`); if it passed itself, every typed call would
 * be reported twice — once as a typed operation and again as the raw SQL it
 * generates. That failure presents as mysterious duplicate errors, so it is pinned
 * here rather than left to be rediscovered.
 */
describe("checked QueryRunner proxy", () => {
    function countingCheck(): {
        calls: number[]
        check: (ctx: CheckContextForCustomCheck) => void
    } {
        const calls: number[] = []
        return {
            calls,
            check: (ctx) => {
                calls.push(ctx.operations.length)
            },
        }
    }

    it("reports a typed DDL call exactly once, not again as generated SQL", async () => {
        const { calls, check } = countingCheck()

        await runMigration(
            (qr) =>
                qr.createIndex("users", {
                    name: "IDX_users_name",
                    columnNames: ["name"],
                    isConcurrent: true,
                } as never),
            { config: { checks: [check] } },
        )

        expect(calls).toHaveLength(1)
        expect(calls[0]).toBe(1)
    })

    it("still intercepts a raw query issued directly by the migration", async () => {
        const { calls, check } = countingCheck()

        await runMigration(
            (qr) =>
                qr.query(
                    'CREATE INDEX CONCURRENTLY "IDX_users_name" ON "users" ("name")',
                ),
            { config: { checks: [check] } },
        )

        expect(calls).toHaveLength(1)
    })

    /**
     * `safetyAssured` works by forking the checker into a new async context. The
     * proxy therefore has to resolve the active checker on each call — capturing it
     * once at creation means the fork is never consulted and the escape hatch
     * silently does nothing.
     */
    it("honours a safetyAssured fork established after the proxy was created", async () => {
        await expect(
            runMigration(async (qr) => {
                await safetyAssured(async () => {
                    await qr.query('ALTER TABLE "users" DROP COLUMN "email"')
                })
            }),
        ).resolves.toBeDefined()
    })

    it("still rejects the same statement outside the safetyAssured block", async () => {
        await expect(
            runMigration(async (qr) => {
                await safetyAssured(async () => {
                    await qr.query('ALTER TABLE "users" DROP COLUMN "email"')
                })
                await qr.query('ALTER TABLE "users" DROP COLUMN "name"')
            }),
        ).rejects.toThrow(/DROP COLUMN/)
    })

    it("passes non-DDL methods straight through", async () => {
        const executed = await runMigration(async (qr) => {
            await qr.startTransaction()
            await qr.commitTransaction()
        })
        expect(executed).toEqual([])
    })

    it("reports every operation in a multi-clause statement at once", async () => {
        const { calls, check } = countingCheck()
        await runMigration(
            (qr) =>
                qr.query(
                    'ALTER TABLE "users" ADD "a" integer, ADD "b" integer',
                ),
            { config: { checks: [check] } },
        )
        expect(calls[0]).toBe(2)
    })
})
