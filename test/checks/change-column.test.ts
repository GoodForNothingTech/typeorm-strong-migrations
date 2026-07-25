import { describe, expect, it } from "vitest"
import { parseSqlType } from "../../src/sql/types"
import { assertSafe, assertUnsafe } from "../helpers/assertions"
import type { FakeTable } from "../helpers/fake-query-runner"

function table(
    columns: Array<{ name: string; type: string; nullable?: boolean }>,
): FakeTable {
    return {
        columns: columns.map((column) => ({
            name: column.name,
            type: parseSqlType(column.type, "postgres"),
            nullable: column.nullable ?? true,
        })),
    }
}

const USERS = {
    users: table([{ name: "name", type: "character varying(100)" }]),
}

describe("changeColumn", () => {
    it("flags narrowing a varchar", async () => {
        await assertUnsafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "users" ALTER COLUMN "name" TYPE character varying(50)`,
                ),
            /Changing the type of an existing column blocks reads and writes/,
            { tables: USERS },
        )
    })

    it("allows widening a varchar", async () => {
        await assertSafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "users" ALTER COLUMN "name" TYPE character varying(200)`,
                ),
            { tables: USERS },
        )
    })

    it("allows varchar to text", async () => {
        await assertSafe(
            (qr) =>
                qr.query(`ALTER TABLE "users" ALTER COLUMN "name" TYPE text`),
            {
                tables: USERS,
            },
        )
    })

    it("allows dropping the length limit entirely", async () => {
        await assertSafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "users" ALTER COLUMN "name" TYPE character varying`,
                ),
            { tables: USERS },
        )
    })

    it("allows increasing numeric precision at the same scale", async () => {
        await assertSafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "t" ALTER COLUMN "amount" TYPE numeric(12,2)`,
                ),
            {
                tables: {
                    t: table([{ name: "amount", type: "numeric(10,2)" }]),
                },
            },
        )
    })

    it("flags changing numeric scale", async () => {
        await assertUnsafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "t" ALTER COLUMN "amount" TYPE numeric(12,4)`,
                ),
            /Changing the type/,
            {
                tables: {
                    t: table([{ name: "amount", type: "numeric(10,2)" }]),
                },
            },
        )
    })

    it("allows cidr to inet", async () => {
        await assertSafe(
            (qr) => qr.query(`ALTER TABLE "t" ALTER COLUMN "ip" TYPE inet`),
            {
                tables: { t: table([{ name: "ip", type: "cidr" }]) },
            },
        )
    })

    it("refuses when the current type cannot be determined", async () => {
        // Unknown state means we cannot prove safety, and refusing is the safe
        // direction — the same place the gem's `rescue []` lands.
        await assertUnsafe(
            (qr) =>
                qr.query(`ALTER TABLE "missing" ALTER COLUMN "x" TYPE text`),
            /Changing the type/,
        )
    })

    it("allows a change to a column added in the same migration", async () => {
        await assertSafe(
            async (qr) => {
                await qr.query(`ALTER TABLE "users" ADD "temp" integer`)
                await qr.query(
                    `ALTER TABLE "users" ALTER COLUMN "temp" TYPE bigint`,
                )
            },
            { tables: USERS },
        )
    })

    describe("mysql", () => {
        const mysqlTable = {
            users: {
                columns: [
                    {
                        name: "name",
                        type: parseSqlType("varchar(100)", "mysql"),
                        nullable: true,
                    },
                ],
            },
        }

        it("allows widening a varchar within one length-byte", async () => {
            // maxlen 1 => threshold 255, so 100 -> 200 keeps a single length byte.
            await assertSafe(
                (qr) =>
                    qr.query(
                        "ALTER TABLE `users` CHANGE `name` `name` varchar(200)",
                    ),
                { dialect: "mysql", tables: mysqlTable, charsetMaxLen: 1 },
            )
        })

        it("flags a widening that crosses the length-byte threshold", async () => {
            // maxlen 1 => threshold 255. Growing 100 -> 300 crosses it, so the row
            // format's length prefix widens and the table is rewritten.
            await assertUnsafe(
                (qr) =>
                    qr.query(
                        "ALTER TABLE `users` CHANGE `name` `name` varchar(300)",
                    ),
                /Changing the type of an existing column blocks writes/,
                { dialect: "mysql", tables: mysqlTable, charsetMaxLen: 1 },
            )
        })

        it("allows a widening when the prefix width is already wide", async () => {
            // maxlen 4 => threshold 63. The old length already exceeds it, so the
            // prefix is unchanged and no rewrite happens.
            await assertSafe(
                (qr) =>
                    qr.query(
                        "ALTER TABLE `users` CHANGE `name` `name` varchar(200)",
                    ),
                { dialect: "mysql", tables: mysqlTable, charsetMaxLen: 4 },
            )
        })
    })
})

describe("changeColumnNull", () => {
    it("flags SET NOT NULL on Postgres and shows the NOT VALID rewrite", async () => {
        const error = await assertUnsafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL`,
                ),
            /Setting NOT NULL on an existing column blocks reads and writes/,
            { tables: USERS },
        )
        expect(error.message).toContain('CHECK ("name" IS NOT NULL) NOT VALID')
        expect(error.message).toContain("VALIDATE CONSTRAINT")
        expect(error.message).toContain("SET NOT NULL")
    })

    it("allows DROP NOT NULL", async () => {
        await assertSafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "users" ALTER COLUMN "name" DROP NOT NULL`,
                ),
            { tables: USERS },
        )
    })

    it("allows SET NOT NULL when a validated IS NOT NULL constraint already proves it", async () => {
        await assertSafe(
            (qr) =>
                qr.query(
                    `ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL`,
                ),
            {
                tables: {
                    users: {
                        ...USERS.users,
                        checkConstraints: [
                            {
                                name: "users_name_null",
                                definition: 'CHECK (("name" IS NOT NULL))',
                                validated: true,
                            },
                        ],
                    },
                },
            },
        )
    })

    /**
     * MySQL has no `ALTER COLUMN ... SET NOT NULL`; nullability only ever changes as
     * part of a CHANGE/MODIFY that restates the whole column. So both MySQL rules
     * are reached through that combined form.
     */
    it("names strict mode when MySQL is not in strict mode", async () => {
        await assertUnsafe(
            (qr) =>
                qr.query(
                    "ALTER TABLE `users` CHANGE `name` `name` varchar(100) NOT NULL",
                ),
            /not safe without strict mode enabled/,
            {
                dialect: "mysql",
                strictMode: false,
                tables: {
                    users: table([{ name: "name", type: "varchar(100)" }]),
                },
                charsetMaxLen: 1,
            },
        )
    })

    it("still flags setting NOT NULL under strict mode, as the scan is the hazard", async () => {
        const error = await assertUnsafe(
            (qr) =>
                qr.query(
                    "ALTER TABLE `users` CHANGE `name` `name` varchar(100) NOT NULL",
                ),
            /Changing the type is safe, but setting NOT NULL is not/,
            {
                dialect: "mysql",
                strictMode: true,
                tables: {
                    users: table([{ name: "name", type: "varchar(100)" }]),
                },
                charsetMaxLen: 1,
            },
        )
        expect(error.key).toBe("changeColumnWithNotNull")
    })
})

describe("changeColumnConstraint", () => {
    it("flags a type change on a column carrying a check constraint", async () => {
        const error = await assertUnsafe(
            (qr) =>
                qr.query(`ALTER TABLE "users" ALTER COLUMN "name" TYPE text`),
            /column that has check constraints/,
            {
                tables: {
                    users: {
                        ...USERS.users,
                        checkConstraints: [
                            {
                                name: "users_name_len",
                                definition: "CHECK ((length(name) > 2))",
                                validated: true,
                            },
                        ],
                    },
                },
            },
        )
        // Fires even though varchar -> text is otherwise a safe change.
        expect(error.key).toBe("changeColumnConstraint")
        expect(error.message).toContain("DROP CONSTRAINT")
        expect(error.message).toContain("NOT VALID")
    })
})
