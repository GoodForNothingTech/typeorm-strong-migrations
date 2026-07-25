import { describe, expect, it } from "vitest"
import { assertSafe, assertUnsafe } from "../helpers/assertions"

/**
 * Two operation kinds the analyzer modelled but nothing subscribed to, so they
 * parsed cleanly, classified as DDL, and executed with no report. Neither has a
 * counterpart in the gem — Rails has no `truncate` migration method, and
 * `add_primary_key` is not a thing there either.
 */
describe("truncate", () => {
    it("flags TRUNCATE, which is unrecoverable", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(`TRUNCATE TABLE "users"`),
            /removes every row/,
        )
        expect(error.key).toBe("truncate")
        expect(error.message).toContain("safetyAssured")
    })

    it("flags the typed clearTable call too", async () => {
        const error = await assertUnsafe((qr) => qr.clearTable("users"))
        expect(error.key).toBe("truncate")
        expect(error.message).toContain("queryRunner.clearTable")
    })

    it("reports every table in a multi-table TRUNCATE", async () => {
        const error = await assertUnsafe((qr) =>
            qr.query(`TRUNCATE TABLE "users", "orders"`),
        )
        // Both tables are named, not just the first.
        expect(error.message).toMatch(/users|orders/)
    })

    it("allows truncating a table created in the same migration", async () => {
        await assertSafe(async (qr) => {
            await qr.query(`CREATE TABLE "tmp" ("id" SERIAL NOT NULL)`)
            await qr.query(`TRUNCATE TABLE "tmp"`)
        })
    })

    it("respects safetyAssured", async () => {
        await assertSafe((qr) => qr.query(`TRUNCATE TABLE "users"`), {
            safetyAssured: true,
        })
    })
})

describe("createPrimaryKey", () => {
    /**
     * Adding a primary key builds a unique index over every row *and* sets the
     * columns NOT NULL, both under an ACCESS EXCLUSIVE lock — the two hazards
     * `createUniqueConstraint` and `changeColumnNull` exist to catch, arriving
     * together under a kind neither of them subscribed to.
     */
    it("flags adding a primary key to an existing table", async () => {
        const error = await assertUnsafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "users" ADD CONSTRAINT "PK_users" PRIMARY KEY ("id")`,
                ),
            /Adding a primary key to an existing table/,
        )
        expect(error.key).toBe("createPrimaryKey")
        expect(error.message).toContain("CREATE UNIQUE INDEX CONCURRENTLY")
        expect(error.message).toContain("PRIMARY KEY USING INDEX")
        expect(error.message).toContain("SET NOT NULL")
    })

    it("allows the USING INDEX form, which is the safe one", async () => {
        await assertSafe((qr) =>
            qr.query(
                `ALTER TABLE "users" ADD CONSTRAINT "PK_users" PRIMARY KEY USING INDEX "IDX_users_id"`,
            ),
        )
    })

    it("allows a primary key on a table created in the same migration", async () => {
        await assertSafe(async (qr) => {
            await qr.query(`CREATE TABLE "fresh" ("id" integer NOT NULL)`)
            await qr.query(
                `ALTER TABLE "fresh" ADD CONSTRAINT "PK_fresh" PRIMARY KEY ("id")`,
            )
        })
    })

    it("flags the typed createPrimaryKey call", async () => {
        const error = await assertUnsafe((qr) =>
            qr.createPrimaryKey("users", ["id"]),
        )
        expect(error.key).toBe("createPrimaryKey")
    })

    it("respects disabling the check", async () => {
        await assertSafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "users" ADD CONSTRAINT "PK_users" PRIMARY KEY ("id")`,
                ),
            { config: { enabledChecks: { createPrimaryKey: false } } },
        )
    })
})
