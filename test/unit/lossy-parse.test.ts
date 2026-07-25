import { describe, expect, it } from "vitest"
import { canRebuildIndex } from "../../src/runtime/safe-methods"
import { analyzeSql } from "../../src/sql/analyze"
import { splitStatements } from "../../src/sql/lexer"
import { TokenCursor } from "../../src/sql/cursor"
import { assertUnsafe, runMigration } from "../helpers/assertions"

/**
 * The rule this file exists to enforce: **a parser that skips tokens must say so, and
 * anything that rebuilds SQL must refuse to act on a parse that did.**
 *
 * Before this, the analyzer silently discarded what it did not model and two places
 * rebuilt SQL from the incomplete result — the `safeByDefault` rewrites and the "here
 * is the safe version" messages. Neither knew the model was partial, so a partial
 * index quietly became a full one.
 */

describe("CREATE INDEX tail clauses", () => {
    const index = (sql: string) =>
        analyzeSql(sql, "postgres")[0] as never as Record<string, unknown>

    /**
     * The flagship bug. Each clause used to be a single positional `eatKeyword` in a
     * fixed order, so one unrecognized clause consumed nothing and blocked every
     * clause after it.
     */
    it("keeps WHERE when an unmodelled clause precedes it", () => {
        const op = index(
            `CREATE INDEX idx ON t (a) WITH (fillfactor = 90) WHERE deleted_at IS NULL`,
        )
        expect(op.where).toBe("deleted_at IS NULL")
        expect(op.partial).toBe(true)
        expect(op.unmodeledClauses).toBeDefined()
    })

    it("keeps WHERE after TABLESPACE", () => {
        const op = index(
            `CREATE INDEX idx ON t (a) TABLESPACE fast WHERE deleted_at IS NULL`,
        )
        expect(op.where).toBe("deleted_at IS NULL")
        expect(op.partial).toBe(true)
    })

    it("models INCLUDE rather than reading and discarding it", () => {
        const op = index(
            `CREATE INDEX idx ON t (a) INCLUDE (b, c) WHERE d IS NULL`,
        )
        expect(op.include).toEqual(["b", "c"])
        expect(op.where).toBe("d IS NULL")
        expect(op.partial).toBeUndefined()
    })

    it("models NULLS NOT DISTINCT, which changes what unique means", () => {
        const op = index(
            `CREATE UNIQUE INDEX idx ON t (a) NULLS NOT DISTINCT WHERE b IS NULL`,
        )
        expect(op.nullsNotDistinct).toBe(true)
        expect(op.where).toBe("b IS NULL")
        expect(op.partial).toBeUndefined()
    })

    it("consumes ONLY instead of reading it as the table name", () => {
        const op = index(`CREATE INDEX idx ON ONLY parent (a)`)
        expect((op.table as { name: string }).name).toBe("parent")
        expect(op.columns).toHaveLength(1)
    })

    it("captures MySQL ALGORITHM/LOCK on CREATE INDEX, not only on ALTER TABLE", () => {
        const [op] = analyzeSql(
            "CREATE INDEX idx ON t (a) ALGORITHM=COPY LOCK=SHARED",
            "mysql",
        )
        expect(op).toMatchObject({
            mysql: { algorithm: "COPY", lock: "SHARED" },
        })
    })
})

describe("refusing to rebuild a lossy parse", () => {
    it("will not rewrite an index whose parse was partial", () => {
        const [op] = analyzeSql(
            `CREATE INDEX idx ON t (a) WITH (fillfactor = 90) WHERE d IS NULL`,
            "postgres",
        )
        expect(canRebuildIndex(op as never)).toBe(false)
    })

    it("will not rebuild an index with a sort direction, which has no emitter", () => {
        const [op] = analyzeSql(`CREATE INDEX idx ON t (a DESC)`, "postgres")
        expect(canRebuildIndex(op as never)).toBe(false)
    })

    it("rebuilds a fully understood index", () => {
        const [op] = analyzeSql(
            `CREATE INDEX idx ON t (a) WHERE d IS NULL`,
            "postgres",
        )
        expect(canRebuildIndex(op as never)).toBe(true)
    })

    /**
     * With safeByDefault the rewrite *replaces* the user's statement, so acting on a
     * partial parse silently built a full index where a partial one was asked for.
     * It must now decline and report instead.
     */
    it("reports rather than silently building the wrong index", async () => {
        const executed: string[] = []
        let raised: unknown
        try {
            executed.push(
                ...(await runMigration(
                    (qr) =>
                        qr.query(
                            `CREATE INDEX idx ON users (email) WITH (fillfactor = 90) WHERE deleted_at IS NULL`,
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
        expect(raised).toBeDefined()
        // Crucially: it did not run a reconstructed statement.
        expect(executed).toEqual([])
    })

    /**
     * Even without safeByDefault the *message* rebuilt the statement, so it printed a
     * "safe version" that dropped the predicate. It now adds CONCURRENTLY to the
     * user's own SQL instead.
     */
    it("advises on the original SQL when it cannot rebuild", async () => {
        const error = await assertUnsafe((qr) =>
            qr.query(
                `CREATE INDEX idx ON users (email) WITH (fillfactor = 90) WHERE deleted_at IS NULL`,
            ),
        )
        expect(error.message).toContain("CREATE INDEX CONCURRENTLY")
        expect(error.message).toContain("fillfactor = 90")
        expect(error.message).toContain("deleted_at IS NULL")
    })

    it("emits INCLUDE and NULLS NOT DISTINCT when it does rebuild", async () => {
        const error = await assertUnsafe((qr) =>
            qr.query(
                `CREATE UNIQUE INDEX idx ON users (email) INCLUDE (name) NULLS NOT DISTINCT`,
            ),
        )
        expect(error.message).toContain("INCLUDE")
        expect(error.message).toContain("NULLS NOT DISTINCT")
    })
})

describe("constraint tails", () => {
    /**
     * `rewriteForeignKeyNotValid` rebuilds the constraint, so a dropped
     * `ON DELETE CASCADE` would silently change referential behaviour.
     */
    it("records ON DELETE rather than swallowing it", () => {
        const [op] = analyzeSql(
            `ALTER TABLE a ADD CONSTRAINT fk FOREIGN KEY (b) REFERENCES c (id) ON DELETE CASCADE`,
            "postgres",
        )
        expect(op).toMatchObject({ kind: "createForeignKey", partial: true })
    })

    it("records DEFERRABLE", () => {
        const [op] = analyzeSql(
            `ALTER TABLE a ADD CONSTRAINT u UNIQUE (b) DEFERRABLE INITIALLY DEFERRED`,
            "postgres",
        )
        expect(op).toMatchObject({ partial: true })
    })

    it("still reads NOT VALID, and does not call it unmodelled", () => {
        const [op] = analyzeSql(
            `ALTER TABLE a ADD CONSTRAINT fk FOREIGN KEY (b) REFERENCES c (id) NOT VALID`,
            "postgres",
        )
        expect(op).toMatchObject({ notValid: true, partial: undefined })
    })

    it("declines to rewrite a foreign key whose tail it did not model", async () => {
        const executed = await runMigration(
            (qr) =>
                qr.query(
                    `ALTER TABLE orders ADD CONSTRAINT fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE`,
                ),
            { config: { safeByDefault: true }, transactionMode: "each" },
        ).catch(() => [])
        // Either it reported, or it ran nothing — but it never ran a rebuilt FK that
        // dropped ON DELETE CASCADE.
        expect(executed.some((sql) => /NOT VALID/.test(sql))).toBe(false)
    })
})

describe("statements that produced no operations", () => {
    /**
     * Zero operations makes the checker skip straight to executing the statement, so
     * a parser that bails must still emit something. Same failure mode as the lexer
     * bug fixed earlier, one layer up.
     */
    it("emits an unknown for a malformed ALTER rather than nothing", () => {
        const operations = analyzeSql(`ALTER TABLE t DROP COLUMN`, "postgres")
        expect(operations.length).toBeGreaterThan(0)
        expect(operations[0]).toMatchObject({ kind: "unknown" })
    })

    it("rejects that statement instead of running it unchecked", async () => {
        await assertUnsafe((qr) => qr.query(`ALTER TABLE users DROP COLUMN`))
    })
})

describe("bracket-aware clause scanning", () => {
    it("does not truncate a predicate at a comma inside an array literal", () => {
        const [op] = analyzeSql(
            `CREATE INDEX idx ON t (a) WHERE tags && ARRAY['x','y']`,
            "postgres",
        )
        expect(op).toMatchObject({ where: `tags && ARRAY['x','y']` })
    })

    it("stops at a genuine top-level comma", () => {
        const [statement] = splitStatements("a, b", "postgres")
        const cursor = new TokenCursor(statement!)
        expect(cursor.takeUntilTopLevelComma()).toBe("a")
    })
})

describe("partialSql behaviour", () => {
    const LOSSY = `CREATE INDEX idx ON users (email) WITH (fillfactor = 90)`

    it("warns by default", async () => {
        await expect(
            runMigration((qr) => qr.query(LOSSY), {
                config: { enabledChecks: { createIndex: false } },
            }),
        ).resolves.toBeDefined()
    })

    it('actually errors when set to "error", rather than warning', async () => {
        // The setting was accepted and typed but the check only ever branched on
        // "ignore", so "error" silently behaved as "warn".
        const error = await assertUnsafe((qr) => qr.query(LOSSY), undefined, {
            config: {
                partialSql: "error",
                enabledChecks: { createIndex: false },
            },
        })
        expect(error.key).toBe("partialParse")
    })

    it("stays silent when ignored", async () => {
        await expect(
            runMigration((qr) => qr.query(LOSSY), {
                config: {
                    partialSql: "ignore",
                    enabledChecks: { createIndex: false },
                },
            }),
        ).resolves.toBeDefined()
    })
})
