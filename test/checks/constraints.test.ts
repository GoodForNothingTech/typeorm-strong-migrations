import { describe, expect, it } from "vitest"
import { assertSafe, assertUnsafe } from "../helpers/assertions"

const ADD_FK = `ALTER TABLE "account" ADD CONSTRAINT "FK_1" FOREIGN KEY ("userId") REFERENCES "user"("id")`

describe("createForeignKey", () => {
    it("flags a validated foreign key and shows the NOT VALID split", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(ADD_FK),
            /Adding a foreign key blocks writes on both tables/,
        )
        expect(error.message).toContain("NOT VALID")
        expect(error.message).toContain("VALIDATE CONSTRAINT")
    })

    it("allows NOT VALID", async () => {
        await assertSafe((qr) => qr.query(`${ADD_FK} NOT VALID`))
    })

    /**
     * Deliberately not exempt for a table created in this migration: the lock lands
     * on the *referenced* table too, which is almost never new.
     */
    it("still flags a foreign key on a table created in the same migration", async () => {
        await assertUnsafe(async (qr) => {
            await qr.query(`CREATE TABLE "account" ("id" SERIAL NOT NULL)`)
            await qr.query(ADD_FK)
        }, /blocks writes on both tables/)
    })

    it("gives MySQL the foreign_key_checks workaround instead", async () => {
        const error = await assertUnsafe(
            (qr) =>
                qr.query(
                    "ALTER TABLE `account` ADD CONSTRAINT `FK_1` FOREIGN KEY (`userId`) REFERENCES `user`(`id`)",
                ),
            /blocks writes on both tables/,
            { dialect: "mysql" },
        )
        expect(error.key).toBe("createForeignKeyMysql")
        expect(error.message).toContain("SET SESSION foreign_key_checks = 0")
        expect(error.message).not.toContain("NOT VALID")
    })
})

describe("createCheckConstraint", () => {
    const ADD_CHECK = `ALTER TABLE "users" ADD CONSTRAINT "CHK_1" CHECK (age > 0)`

    it("flags a validated check constraint", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(ADD_CHECK),
            /Adding a check constraint blocks reads and writes/,
        )
        expect(error.message).toContain("NOT VALID")
    })

    it("allows NOT VALID", async () => {
        await assertSafe((qr) => qr.query(`${ADD_CHECK} NOT VALID`))
    })

    it("allows a constraint on a table created in the same migration", async () => {
        await assertSafe(async (qr) => {
            await qr.query(`CREATE TABLE "users" ("id" SERIAL NOT NULL)`)
            await qr.query(ADD_CHECK)
        })
    })

    it("tells MySQL there is no safe form", async () => {
        const error = await assertUnsafe(
            (qr) =>
                qr.query(
                    "ALTER TABLE `users` ADD CONSTRAINT `CHK_1` CHECK (age > 0)",
                ),
            /not safe with your database engine/,
            { dialect: "mysql" },
        )
        expect(error.key).toBe("createCheckConstraintMysql")
    })
})

describe("createUniqueConstraint", () => {
    it("flags the plain form and shows the concurrent-index route", async () => {
        const error = await assertUnsafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "users" ADD CONSTRAINT "UQ_1" UNIQUE ("email")`,
                ),
            /Adding a unique constraint creates a unique index/,
        )
        expect(error.message).toContain("CREATE UNIQUE INDEX CONCURRENTLY")
        expect(error.message).toContain("UNIQUE USING INDEX")
    })

    it("allows the USING INDEX form, which is the safe one", async () => {
        await assertSafe((qr) =>
            qr.query(
                `ALTER TABLE "users" ADD CONSTRAINT "UQ_1" UNIQUE USING INDEX "IDX_users_email"`,
            ),
        )
    })
})

describe("createExclusionConstraint", () => {
    it("flags it and says there is no safe alternative", async () => {
        const error = await assertUnsafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "room" ADD CONSTRAINT "EX_1" EXCLUDE USING gist (during WITH &&)`,
                ),
            /Adding an exclusion constraint blocks reads and writes/,
        )
        expect(error.message).toContain("cannot be added NOT VALID")
    })
})

describe("validateConstraint", () => {
    it("flags validating while this session holds a write-blocking lock", async () => {
        await assertUnsafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "users" VALIDATE CONSTRAINT "users_name_null"`,
                ),
            /Validating a check constraint while writes are blocked/,
            { writesBlocked: true },
        )
    })

    it("allows validating when no write-blocking lock is held", async () => {
        await assertSafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "users" VALIDATE CONSTRAINT "users_name_null"`,
                ),
            { writesBlocked: false },
        )
    })

    it("uses the foreign-key wording when the constraint is a foreign key", async () => {
        const error = await assertUnsafe(
            (qr) => qr.query(`ALTER TABLE "users" VALIDATE CONSTRAINT "FK_1"`),
            undefined,
            {
                writesBlocked: true,
                tables: {
                    users: {
                        columns: [],
                        checkConstraints: [
                            {
                                name: "FK_1",
                                definition: "FOREIGN KEY (a)",
                                validated: false,
                                type: "f",
                            },
                        ],
                    },
                },
            },
        )
        expect(error.key).toBe("validateForeignKey")
    })
})
