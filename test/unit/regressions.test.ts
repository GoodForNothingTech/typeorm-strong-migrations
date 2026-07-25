import { describe, expect, it } from "vitest"
import { createAdapter, reconcileMariaDb } from "../../src/adapters/factory"
import { StrongMigrationsError, UnsafeMigrationError } from "../../src/errors"
import { lintSql } from "../../src/lint"
import { analyzeSql } from "../../src/sql/analyze"
import { parseSqlType } from "../../src/sql/types"
import { runMigration } from "../helpers/assertions"
import { createFakeRunner } from "../helpers/fake-query-runner"

/**
 * Every case here is a bug that shipped past a green suite.
 *
 * They cluster in three blind spots the original tests shared: multi-line SQL
 * (every fixture was a single line, so byte-offset bugs were invisible), lexer
 * failure paths, and statements that yield more than one operation. Each test
 * below fails against the code as it was written.
 */

describe("lexer failure paths", () => {
    /**
     * The dangerous direction. A statement that produced no tokens was dropped
     * entirely, so `analyzeSql` returned `[]` — and zero operations makes the
     * checker skip straight to executing the query. Input we explicitly could not
     * understand was the input we checked least.
     */
    it("keeps a statement whose lexing failed before the first token", () => {
        const operations = analyzeSql(
            "/* oops ALTER TABLE users DROP COLUMN email",
            "postgres",
        )
        expect(operations).toHaveLength(1)
        expect(operations[0]).toMatchObject({
            kind: "unknown",
            reason: "lex-error",
        })
    })

    it("treats an unterminated string as unparsed rather than as nothing", () => {
        const operations = analyzeSql(
            "ALTER TABLE users ADD c text DEFAULT 'unterminated",
            "postgres",
        )
        expect(operations.length).toBeGreaterThan(0)
        expect(operations.some((op) => op.kind === "unknown")).toBe(true)
    })
})

describe("source offsets in multi-line SQL", () => {
    /**
     * Statements stored trimmed text but the untrimmed start offset, so every
     * fragment TokenCursor sliced back out was shifted by the leading whitespace.
     * Single-line fixtures never trimmed anything, which is why the whole suite
     * missed it — and multi-line template literals are the normal way to write a
     * migration.
     */
    it("extracts a CHECK expression unshifted", () => {
        const [op] = analyzeSql(
            `
            ALTER TABLE "users"
                ADD CONSTRAINT "chk_age" CHECK (age > 0)
            `,
            "postgres",
        )
        expect(op).toMatchObject({
            kind: "createCheckConstraint",
            expression: "age > 0",
        })
    })

    it("extracts an index predicate unshifted", () => {
        const [op] = analyzeSql(
            `
            CREATE INDEX "IDX_a" ON "users" ("email")
                WHERE "deleted_at" IS NULL
            `,
            "postgres",
        )
        expect(op).toMatchObject({ where: `"deleted_at" IS NULL` })
    })

    it("extracts an expression index column unshifted", () => {
        const [op] = analyzeSql(
            `
            CREATE INDEX "IDX_a"
                ON "users" (lower(email))
            `,
            "postgres",
        )
        expect(op).toMatchObject({
            kind: "createIndex",
            columns: [{ expression: "lower(email)" }],
        })
    })
})

describe("marker comments", () => {
    /**
     * Markers were matched against the whole statement, so the string appearing in
     * ordinary data switched off every check for real DDL.
     */
    it("ignores a marker inside a string literal", () => {
        const [op] = analyzeSql(
            `ALTER TABLE "users" ADD "note" text DEFAULT 'strong-migrations:ignore'`,
            "postgres",
        )
        expect(op?.markers?.safetyAssured).toBeFalsy()
    })

    it("honours a marker in a trailing comment, not only a leading one", () => {
        const [op] = analyzeSql(
            `DROP TABLE "users" /* strong-migrations:ignore */`,
            "postgres",
        )
        expect(op?.markers?.safetyAssured).toBe(true)
    })
})

describe("statements yielding several operations", () => {
    /**
     * safeByDefault made things strictly worse here. Checks returned `rewrite`
     * rather than `unsafe`, so `errors` was empty; the rewrite was then discarded
     * because it is only valid for a single operation — and the original blocking
     * SQL ran with no report at all.
     */
    it("rejects rather than silently executing when a rewrite cannot apply", async () => {
        const executed: string[] = []
        let raised: unknown
        try {
            executed.push(
                ...(await runMigration(
                    (qr) =>
                        qr.query(
                            `CREATE INDEX "IDX_a" ON "users" ("email"); CREATE INDEX "IDX_b" ON "users" ("name")`,
                        ),
                    {
                        config: { safeByDefault: true },
                        transactionMode: "each",
                    },
                )),
            )
        } catch (error) {
            raised = error
        }

        expect(raised).toBeInstanceOf(StrongMigrationsError)
        expect((raised as Error).name).toMatch(/UnsafeMigrationError/)
        // The point of the bug: the blocking SQL used to run anyway.
        expect(executed).toEqual([])
    })

    it("still rewrites when the statement is a single operation", async () => {
        const executed = await runMigration(
            (qr) => qr.query(`CREATE INDEX "IDX_a" ON "users" ("email")`),
            { config: { safeByDefault: true }, transactionMode: "each" },
        )
        expect(executed.some((sql) => /CONCURRENTLY/.test(sql))).toBe(true)
    })

    it("reports every table in a multi-table DROP", () => {
        // The old check read tables[0] only, so a freshly created first table
        // exempted the production table listed after it.
        const result = lintSql(
            `CREATE TABLE "tmp_new" ("id" integer); DROP TABLE "tmp_new", "users";`,
            { dialect: "postgres" },
        )
        expect(result.findings.map((finding) => finding.key)).toEqual([
            "dropTable",
        ])
    })
})

describe("DML boundedness", () => {
    /**
     * Boundedness was decided by scanning every token for `where`/`limit`, so one
     * inside a subquery reclassified a full-table rewrite as benign — and benign
     * operations are filtered out before any check runs.
     */
    it("does not treat a subquery WHERE as bounding the outer UPDATE", () => {
        const [op] = analyzeSql(
            `UPDATE "users" SET "flag" = (SELECT 1 FROM "t" WHERE "t"."id" = "users"."id")`,
            "postgres",
        )
        expect(op?.kind).toBe("backfill")
    })

    it("does not treat a subquery LIMIT as bounding the outer UPDATE", () => {
        const [op] = analyzeSql(
            `UPDATE "users" SET "flag" = (SELECT 1 FROM "t" LIMIT 1)`,
            "postgres",
        )
        expect(op?.kind).toBe("backfill")
    })

    it("still recognizes a genuine top-level WHERE", () => {
        const [op] = analyzeSql(
            `UPDATE "users" SET "flag" = true WHERE "id" = 1`,
            "postgres",
        )
        expect(op?.kind).toBe("benign")
    })
})

describe("bookkeeping suppression", () => {
    /**
     * The catalog exemption matched the whole statement body, so the standard
     * idempotent-migration idiom — a DO block guarded by an information_schema
     * lookup — was written off as bookkeeping along with the DDL inside it.
     */
    it("does not exempt real DDL that merely mentions a catalog table", () => {
        const result = lintSql(
            `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM information_schema.columns) THEN ALTER TABLE users DROP COLUMN email; END IF; END $$`,
            { dialect: "postgres" },
        )
        expect(result.findings.length).toBeGreaterThan(0)
    })

    it("still exempts an actual catalog read", () => {
        const result = lintSql(
            `SELECT 1 FROM information_schema.columns WHERE table_name = 'users'`,
            { dialect: "postgres" },
        )
        expect(result.findings).toEqual([])
    })
})

describe("adapter identity", () => {
    /**
     * reconcileMariaDb swapped the prototype, but key/name/dialect/minVersion are
     * instance fields set by the MysqlAdapter constructor — so the "upgraded"
     * adapter kept reporting MySQL, and MariaDB's 10.5 floor was never enforced.
     */
    it("reports MariaDB after reconciling a MySQL-typed driver", () => {
        const { queryRunner } = createFakeRunner({ dialect: "mysql" })
        const adapter = reconcileMariaDb(
            createAdapter("mysql", queryRunner),
            "10.11.6-MariaDB-1:10.11.6+maria~ubu2204",
            queryRunner,
        )
        expect(adapter.key).toBe("mariadb")
        expect(adapter.dialect).toBe("mariadb")
        expect(adapter.minVersion).toBe("10.5")
        expect(adapter.version()).toContain("MariaDB")
    })

    it("leaves a genuine MySQL adapter alone", () => {
        const { queryRunner } = createFakeRunner({ dialect: "mysql" })
        const adapter = reconcileMariaDb(
            createAdapter("mysql", queryRunner),
            "8.4.0",
            queryRunner,
        )
        expect(adapter.key).toBe("mysql")
    })
})

describe("prototype-chain safety", () => {
    /**
     * Lookups used plain property access on objects keyed by user-supplied strings,
     * so a type or check named after an Object.prototype member resolved to a
     * function and threw from inside the analyzer.
     */
    it("does not blow up on a type named after a prototype member", () => {
        expect(() => parseSqlType("constructor", "postgres")).not.toThrow()
        expect(() => parseSqlType("toString(10)", "postgres")).not.toThrow()
    })
})

describe("SAFETY_ASSURED", () => {
    /**
     * Bare truthiness meant `SAFETY_ASSURED=0` — the natural way to switch it off in
     * a deploy config — silently disabled every check in the library.
     */
    it.each(["0", "false", "no", "off", ""])(
        "treats %j as unset",
        async (value) => {
            process.env.SAFETY_ASSURED = value
            try {
                await expect(
                    runMigration((qr) =>
                        qr.query(`ALTER TABLE "users" DROP COLUMN "email"`),
                    ),
                ).rejects.toThrow(UnsafeMigrationError)
            } finally {
                delete process.env.SAFETY_ASSURED
            }
        },
    )

    it("honours a genuine opt-in", async () => {
        process.env.SAFETY_ASSURED = "1"
        try {
            await expect(
                runMigration((qr) =>
                    qr.query(`ALTER TABLE "users" DROP COLUMN "email"`),
                ),
            ).resolves.toBeDefined()
        } finally {
            delete process.env.SAFETY_ASSURED
        }
    })
})
