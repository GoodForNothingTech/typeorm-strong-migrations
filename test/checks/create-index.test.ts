import { describe, expect, it } from "vitest"
import { assertSafe, assertUnsafe, runMigration } from "../helpers/assertions"

const ADD_INDEX = 'CREATE INDEX "IDX_users_name" ON "users" ("name")'

describe("createIndex", () => {
    it("rejects a non-concurrent index and shows the concurrent rewrite", async () => {
        const error = await assertUnsafe((qr) => qr.query(ADD_INDEX))
        expect(error.key).toBe("createIndex")
        expect(error.message).toContain(
            "Adding an index non-concurrently blocks writes",
        )
        expect(error.message).toContain("CREATE INDEX CONCURRENTLY")
        expect(error.message).toContain("public transaction = false")
        // The remedy is useless without the mode change, so it must be stated.
        expect(error.message).toContain('migrationsTransactionMode: "each"')
    })

    it("allows a concurrent index", async () => {
        await assertSafe((qr) =>
            qr.query(
                'CREATE INDEX CONCURRENTLY "IDX_users_name" ON "users" ("name")',
            ),
        )
    })

    it("allows an index on a table created in the same migration", async () => {
        await assertSafe(async (qr) => {
            await qr.query(
                'CREATE TABLE "posts" ("id" SERIAL NOT NULL, "title" text)',
            )
            await qr.query(
                'CREATE INDEX "IDX_posts_title" ON "posts" ("title")',
            )
        })
    })

    it("does not flag MySQL, where index creation is online", async () => {
        await assertSafe(
            (qr) =>
                qr.query("CREATE INDEX `IDX_users_name` ON `users` (`name`)"),
            {
                dialect: "mysql",
            },
        )
    })

    it("respects safetyAssured on the migration", async () => {
        await assertSafe((qr) => qr.query(ADD_INDEX), { safetyAssured: true })
    })

    it("respects SAFETY_ASSURED", async () => {
        process.env.SAFETY_ASSURED = "1"
        try {
            await assertSafe((qr) => qr.query(ADD_INDEX))
        } finally {
            delete process.env.SAFETY_ASSURED
        }
    })

    it("respects startAfter", async () => {
        await assertSafe((qr) => qr.query(ADD_INDEX), {
            version: 1_600_000_000_000,
            config: { startAfter: 1_700_000_000_000 },
        })
    })

    it("respects disabling the check", async () => {
        await assertSafe((qr) => qr.query(ADD_INDEX), {
            config: { enabledChecks: { createIndex: false } },
        })
    })

    it("accepts the gem's snake_case key when disabling", async () => {
        await assertSafe((qr) => qr.query(ADD_INDEX), {
            config: { enabledChecks: { add_index: false } },
        })
    })

    it("skips checks on down migrations unless checkDown is set", async () => {
        await runMigration((qr) => qr.query(ADD_INDEX), { direction: "down" })
        await assertUnsafe((qr) => qr.query(ADD_INDEX), undefined, {
            direction: "down",
            config: { checkDown: true },
        })
    })

    it("catches the typed createIndex call as well as raw SQL", async () => {
        const error = await assertUnsafe((qr) =>
            qr.createIndex("users", {
                name: "IDX_users_name",
                columnNames: ["name"],
            } as never),
        )
        expect(error.key).toBe("createIndex")
        // The typed path gets typed advice, not a raw-SQL string.
        expect(error.message).toContain("queryRunner.createIndex(")
    })
})

describe("createIndexColumns", () => {
    it("flags a non-unique index with more than three columns", async () => {
        const error = await assertUnsafe(
            (qr) =>
                qr.query(
                    'CREATE INDEX CONCURRENTLY "IDX_x" ON "users" ("a", "b", "c", "d")',
                ),
            /more than three columns/,
        )
        expect(error.header).toBe("Best practice")
    })

    it("allows four columns when the index is unique", async () => {
        await assertSafe((qr) =>
            qr.query(
                'CREATE UNIQUE INDEX CONCURRENTLY "IDX_x" ON "users" ("a", "b", "c", "d")',
            ),
        )
    })

    it("allows three columns", async () => {
        await assertSafe((qr) =>
            qr.query(
                'CREATE INDEX CONCURRENTLY "IDX_x" ON "users" ("a", "b", "c")',
            ),
        )
    })
})

describe("createIndexCorruption", () => {
    const CONCURRENT =
        'CREATE INDEX CONCURRENTLY "IDX_users_name" ON "users" ("name")'

    it("flags Postgres 14.0-14.3 outside development", async () => {
        await assertUnsafe(
            (qr) => qr.query(CONCURRENT),
            /silent data corruption in Postgres 14\.0 to 14\.3/,
            { serverVersion: "14.2", config: { env: "production" } },
        )
    })

    it("allows 14.4", async () => {
        await assertSafe((qr) => qr.query(CONCURRENT), {
            serverVersion: "14.4",
            config: { env: "production" },
        })
    })

    it("stays quiet in development, where the local version is not production's", async () => {
        await assertSafe((qr) => qr.query(CONCURRENT), {
            serverVersion: "14.2",
            config: { env: "development" },
        })
    })
})

describe("concurrentIndexInTransaction", () => {
    const CONCURRENT =
        'CREATE INDEX CONCURRENTLY "IDX_users_name" ON "users" ("name")'

    it("explains the transaction mode rather than letting Postgres raise 25001", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(CONCURRENT),
            undefined,
            {
                isTransactionActive: true,
                transactionMode: "all",
            },
        )
        expect(error.key).toBe("concurrentIndexInTransaction")
        expect(error.message).toContain('migrationsTransactionMode: "each"')
        expect(error.message).toContain("public transaction = false")
    })

    it("asks only for transaction = false when the mode already allows it", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(CONCURRENT),
            undefined,
            {
                isTransactionActive: true,
                transactionMode: "each",
            },
        )
        expect(error.message).toContain("public transaction = false")
        expect(error.message).not.toContain("Two changes are needed")
    })

    it("points at a manual startTransaction when the migration already opted out", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(CONCURRENT),
            undefined,
            {
                isTransactionActive: true,
                transactionMode: "none",
                declaredTransaction: false,
            },
        )
        expect(error.message).toContain("startTransaction()")
    })

    it("is silent outside a transaction", async () => {
        await assertSafe((qr) => qr.query(CONCURRENT), {
            isTransactionActive: false,
        })
    })
})
