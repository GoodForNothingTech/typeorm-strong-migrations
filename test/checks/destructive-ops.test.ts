import { describe, expect, it } from "vitest"
import { assertSafe, assertUnsafe } from "../helpers/assertions"

/**
 * These operations were all invisible before: either the QueryRunner method reached
 * no interception path, or the analyzer classified the statement `benign` and
 * `from-sql` filtered it out before any check ran.
 */

describe("clearDatabase", () => {
    it("flags the method that drops every table", async () => {
        const error = await assertUnsafe(
            (qr) =>
                (
                    qr as never as { clearDatabase(): Promise<void> }
                ).clearDatabase(),
            /drops every table and view/,
        )
        expect(error.key).toBe("clearDatabase")
    })
})

describe("dropSchema", () => {
    it("flags DROP SCHEMA in raw SQL", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(`DROP SCHEMA "legacy" CASCADE`),
            /Dropping a schema destroys every table in it/,
        )
        expect(error.key).toBe("dropSchema")
        expect(error.message).toContain("CASCADE means")
    })

    it("flags the typed call", async () => {
        const error = await assertUnsafe((qr) =>
            qr.dropSchema("legacy", false, true),
        )
        expect(error.key).toBe("dropSchema")
    })

    it("omits the cascade note when there is no CASCADE", async () => {
        const error = await assertUnsafe((qr) =>
            qr.query(`DROP SCHEMA "legacy"`),
        )
        expect(error.message).not.toContain("CASCADE means")
    })
})

describe("dropDatabase", () => {
    it("flags it", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(`DROP DATABASE "old_app"`),
            /Dropping a database destroys everything in it/,
        )
        expect(error.key).toBe("dropDatabase")
    })
})

describe("dropView", () => {
    it("flags dropping a view, like dropping a table", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(`DROP VIEW "active_users"`),
            /breaks every query that reads from it/,
        )
        expect(error.key).toBe("dropView")
    })

    it("flags a materialized view too", async () => {
        await assertUnsafe((qr) =>
            qr.query(`DROP MATERIALIZED VIEW "mv" CASCADE`),
        )
    })

    it("still allows dropping a type or sequence, which is metadata only", async () => {
        await assertSafe(async (qr) => {
            await qr.query(`DROP TYPE "public"."status_enum"`)
            await qr.query(`DROP SEQUENCE "post_id_seq"`)
        })
    })
})

describe("tableRewrite", () => {
    it("flags MySQL ENGINE=, the canonical defragment-in-a-migration outage", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query("ALTER TABLE `users` ENGINE=InnoDB"),
            /rebuilds the entire/,
            { dialect: "mysql" },
        )
        expect(error.key).toBe("tableRewrite")
    })

    it("flags FORCE, which is the same rebuild under another name", async () => {
        await assertUnsafe(
            (qr) => qr.query("ALTER TABLE `users` FORCE"),
            undefined,
            {
                dialect: "mysql",
            },
        )
    })

    it("warns that CONVERT TO CHARACTER SET also retypes columns", async () => {
        const error = await assertUnsafe(
            (qr) =>
                qr.query(
                    "ALTER TABLE `users` CONVERT TO CHARACTER SET utf8mb4",
                ),
            undefined,
            { dialect: "mysql" },
        )
        expect(error.message).toContain("declared type of every string column")
    })

    it("flags Postgres SET LOGGED and SET TABLESPACE", async () => {
        await assertUnsafe((qr) => qr.query(`ALTER TABLE "users" SET LOGGED`))
        await assertUnsafe((qr) =>
            qr.query(`ALTER TABLE "users" SET TABLESPACE fast`),
        )
    })

    it("leaves metadata-only options alone", async () => {
        await assertSafe(
            (qr) =>
                qr.query(
                    "ALTER TABLE `users` COMMENT 'a table', AUTO_INCREMENT=100",
                ),
            { dialect: "mysql" },
        )
    })
})

describe("vacuumFull", () => {
    it("flags VACUUM FULL but not plain VACUUM", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(`VACUUM FULL "users"`),
            /ACCESS EXCLUSIVE lock/,
        )
        expect(error.key).toBe("vacuumFull")
        await assertSafe((qr) => qr.query(`VACUUM "users"`))
        await assertSafe((qr) => qr.query(`VACUUM ANALYZE "users"`))
    })

    it("recognizes the parenthesised option form", async () => {
        await assertUnsafe((qr) => qr.query(`VACUUM (FULL, ANALYZE) "users"`))
        await assertSafe((qr) => qr.query(`VACUUM (ANALYZE) "users"`))
    })
})

describe("disableTrigger", () => {
    /**
     * Postgres implements foreign keys as triggers, so this is the "switch off FK
     * enforcement for a backfill" footgun — and it used to be classified benign
     * because `disable` sat in the table-options set.
     */
    it("flags DISABLE TRIGGER ALL", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(`ALTER TABLE "users" DISABLE TRIGGER ALL`),
            /disables foreign key enforcement/,
        )
        expect(error.key).toBe("disableTrigger")
    })

    it("allows re-enabling, which is the safe half of the pair", async () => {
        await assertSafe((qr) =>
            qr.query(`ALTER TABLE "users" ENABLE TRIGGER ALL`),
        )
    })
})

describe("flushTables", () => {
    it("flags the global read lock but not FLUSH PRIVILEGES", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query("FLUSH TABLES WITH READ LOCK"),
            /global read lock/,
            { dialect: "mysql" },
        )
        expect(error.key).toBe("flushTables")
        await assertSafe((qr) => qr.query("FLUSH PRIVILEGES"), {
            dialect: "mysql",
        })
    })
})

describe("insertSelect", () => {
    it("flags an unbounded INSERT … SELECT", async () => {
        const error = await assertUnsafe(
            (qr) =>
                qr.query(
                    `INSERT INTO "archive" SELECT * FROM "events" WHERE created_at < now()`,
                ),
            /writes as many rows as the SELECT returns/,
        )
        expect(error.key).toBe("insertSelect")
    })

    it("allows a plain VALUES insert", async () => {
        await assertSafe((qr) =>
            qr.query(`INSERT INTO "settings" ("k", "v") VALUES ('a', 'b')`),
        )
    })

    it("allows populating a table created in the same migration", async () => {
        await assertSafe(async (qr) => {
            await qr.query(`CREATE TABLE "archive" ("id" integer)`)
            await qr.query(`INSERT INTO "archive" SELECT id FROM "events"`)
        })
    })
})

describe("primary key drops", () => {
    it("sees dropPrimaryKey, which reached no path before", async () => {
        // Modelled as a constraint drop: cheap on both engines, but it must be *seen*.
        await assertSafe((qr) => qr.dropPrimaryKey("users"))
    })

    it("treats updatePrimaryKeys as adding one", async () => {
        const error = await assertUnsafe((qr) =>
            qr.updatePrimaryKeys("users", [{ name: "id" }] as never),
        )
        expect(error.key).toBe("createPrimaryKey")
    })
})
