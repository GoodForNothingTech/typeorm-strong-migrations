import { describe, expect, it } from "vitest"
import { assertSafe, assertUnsafe } from "../helpers/assertions"

const ENTITIES = [
    {
        name: "User",
        tableName: "users",
        columns: [
            { databaseName: "email", propertyName: "email" },
            { databaseName: "id", propertyName: "id" },
        ],
    },
]

describe("dropColumn", () => {
    /**
     * TypeORM builds explicit SELECT column lists from entity metadata, so a running
     * deploy whose entity still declares the column gets a hard 42703 on every query
     * for that entity. That is a stronger failure than the Rails attribute-cache
     * problem this check exists for, and the advice differs accordingly.
     */
    it("names the entity property that still maps to the column", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(`ALTER TABLE "users" DROP COLUMN "email"`),
            /explicit SELECT column lists from entity metadata/,
            { entities: ENTITIES },
        )
        expect(error.key).toBe("dropColumn")
        expect(error.message).toContain("export class User")
        expect(error.message).toContain("email")
        expect(error.message).toContain("safetyAssured")
    })

    it("falls back to a guessed entity name when metadata has none", async () => {
        const error = await assertUnsafe((qr) =>
            qr.query(`ALTER TABLE "posts" DROP COLUMN "body"`),
        )
        expect(error.message).toContain("export class Post")
    })

    it("allows dropping a column from a table created in the same migration", async () => {
        await assertSafe(async (qr) => {
            await qr.query(
                `CREATE TABLE "tmp" ("id" SERIAL NOT NULL, "x" integer)`,
            )
            await qr.query(`ALTER TABLE "tmp" DROP COLUMN "x"`)
        })
    })

    it("respects safetyAssured, which is the documented remedy", async () => {
        await assertSafe(
            (qr) => qr.query(`ALTER TABLE "users" DROP COLUMN "email"`),
            {
                safetyAssured: true,
            },
        )
    })

    it("respects a per-key safetyAssured list", async () => {
        await assertSafe(
            (qr) => qr.query(`ALTER TABLE "users" DROP COLUMN "email"`),
            {
                safetyAssured: ["dropColumn"],
            },
        )
    })

    it("does not let an unrelated key in the list through", async () => {
        await assertUnsafe(
            (qr) => qr.query(`ALTER TABLE "users" DROP COLUMN "email"`),
            undefined,
            {
                safetyAssured: ["createIndex"],
            },
        )
    })
})

describe("dropTable", () => {
    it("flags a drop and points at the entity", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(`DROP TABLE "users"`),
            /Dropping a table that's in use/,
            { entities: ENTITIES },
        )
        expect(error.key).toBe("dropTable")
        expect(error.message).toContain("User")
    })

    it("allows dropping a table created in the same migration", async () => {
        await assertSafe(async (qr) => {
            await qr.query(`CREATE TABLE "tmp" ("id" SERIAL NOT NULL)`)
            await qr.query(`DROP TABLE "tmp"`)
        })
    })
})

describe("renames", () => {
    it("flags renaming a column", async () => {
        await assertUnsafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "users" RENAME COLUMN "email" TO "email_address"`,
                ),
            /Renaming a column that's in use/,
        )
    })

    it("flags renaming a table", async () => {
        await assertUnsafe(
            (qr) => qr.query(`ALTER TABLE "users" RENAME TO "accounts"`),
            /Renaming a table that's in use/,
        )
    })

    it("flags renaming a schema", async () => {
        await assertUnsafe(
            (qr) => qr.query(`ALTER SCHEMA "old" RENAME TO "new"`),
            /Renaming a schema that's in use/,
        )
    })

    it("flags renaming an enum value and suggests adding one instead", async () => {
        const error = await assertUnsafe(
            (qr) =>
                qr.query(
                    `ALTER TYPE "public"."status" RENAME VALUE 'old' TO 'new'`,
                ),
            /Renaming an enum value that's in use/,
        )
        expect(error.message).toContain("ADD VALUE 'new' AFTER 'old'")
    })

    it("allows adding an enum value, which is the safe form", async () => {
        await assertSafe((qr) =>
            qr.query(
                `ALTER TYPE "public"."status" ADD VALUE 'new' AFTER 'old'`,
            ),
        )
    })

    it("allows renaming a column added in the same migration", async () => {
        await assertSafe(async (qr) => {
            await qr.query(`ALTER TABLE "users" ADD "tmp" integer`)
            await qr.query(`ALTER TABLE "users" RENAME COLUMN "tmp" TO "final"`)
        })
    })
})

describe("backfill", () => {
    /**
     * The gem documents this hazard but cannot detect it — in Rails it is buried in
     * an opaque `execute`. Here the analyzer can see the missing WHERE.
     */
    it("flags an UPDATE with no WHERE", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(`UPDATE "users" SET "active" = true`),
            /updates or deletes every row/,
        )
        expect(error.message).toContain("createQueryBuilder()")
        expect(error.message).toContain("public transaction = false")
    })

    it("flags a DELETE with no WHERE", async () => {
        await assertUnsafe(
            (qr) => qr.query(`DELETE FROM "sessions"`),
            /updates or deletes every row/,
        )
    })

    it("allows a scoped UPDATE", async () => {
        await assertSafe((qr) =>
            qr.query(`UPDATE "users" SET "active" = true WHERE "id" = 1`),
        )
    })

    it("allows a bounded UPDATE", async () => {
        await assertSafe(
            (qr) => qr.query("UPDATE `users` SET `active` = 1 LIMIT 1000"),
            {
                dialect: "mysql",
            },
        )
    })
})

describe("MySQL DDL options", () => {
    it("flags ALGORITHM=COPY and shows the statement without it", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query("ALTER TABLE `users` ADD `x` int, ALGORITHM=COPY"),
            /Using the COPY algorithm blocks writes/,
            { dialect: "mysql" },
        )
        expect(error.message).not.toContain("ALGORITHM=COPY")
    })

    it("flags LOCK=SHARED and says what it blocks", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query("ALTER TABLE `users` ADD `x` int, LOCK=SHARED"),
            /Using shared locking blocks reads/,
            { dialect: "mysql" },
        )
        expect(error.message).not.toContain("LOCK=SHARED")
    })

    it("allows LOCK=NONE", async () => {
        await assertSafe(
            (qr) => qr.query("ALTER TABLE `users` ADD `x` int, LOCK=NONE"),
            {
                dialect: "mysql",
            },
        )
    })

    it("does not apply to Postgres", async () => {
        await assertSafe((qr) =>
            qr.query(`ALTER TABLE "users" ADD "x" integer`),
        )
    })
})

describe("rawQuery", () => {
    it("rejects DDL it cannot interpret rather than waving it through", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(`DO $$ BEGIN ALTER TABLE t DROP COLUMN c; END $$`),
            /could not determine what this statement does/,
        )
        expect(error.header).toBe("Possibly dangerous operation")
    })

    it("stays quiet on statements that are not DDL", async () => {
        await assertSafe((qr) => qr.query(`SELECT pg_advisory_lock(1)`))
    })

    it("never flags TypeORM's own bookkeeping", async () => {
        await assertSafe(async (qr) => {
            await qr.query(
                `CREATE TABLE "migrations" ("id" SERIAL NOT NULL, "name" text)`,
            )
            await qr.query(
                `INSERT INTO "migrations"("timestamp", "name") VALUES ($1, $2)`,
            )
            await qr.query(`SELECT * FROM "migrations" ORDER BY "id" DESC`)
        })
    })

    it("can be downgraded to a warning", async () => {
        await assertSafe((qr) => qr.query(`DO $$ BEGIN END $$`), {
            config: { unknownSql: "warn" },
        })
    })

    it("honours an inline ignore marker", async () => {
        await assertSafe((qr) =>
            qr.query(
                `/* strong-migrations:ignore */ ALTER TABLE "users" DROP COLUMN "email"`,
            ),
        )
    })
})
