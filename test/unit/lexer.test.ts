import { describe, expect, it } from "vitest"
import { splitStatements } from "../../src/sql/lexer"

/**
 * Splitting is where all the correctness risk lives. Every case here is one where
 * a naive `sql.split(";")` gets the wrong answer, and several are dialect-dependent
 * — the same text is one statement in MySQL and three in Postgres.
 */
describe("splitStatements", () => {
    const count = (
        sql: string,
        dialect: "postgres" | "mysql" = "postgres",
    ): number => splitStatements(sql, dialect).length

    it("splits on top-level semicolons", () => {
        expect(count('CREATE TABLE "a" ("b" int); DROP TABLE "c"')).toBe(2)
    })

    it("ignores trailing and repeated semicolons", () => {
        expect(count("SELECT 1;;")).toBe(1)
    })

    it("does not split inside a string literal", () => {
        expect(
            count(`ALTER TABLE "t" ADD CONSTRAINT "c" CHECK (note <> 'a;b')`),
        ).toBe(1)
    })

    it("handles doubled quotes inside a string", () => {
        const [statement] = splitStatements(`SELECT 'it''s; fine'`, "postgres")
        expect(
            statement?.tokens.some((token) => token.value === "it's; fine"),
        ).toBe(true)
    })

    it("does not split inside a dollar-quoted body", () => {
        expect(
            count(
                "CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END; $$ LANGUAGE plpgsql",
            ),
        ).toBe(1)
    })

    it("handles a tagged dollar quote containing the untagged delimiter", () => {
        expect(
            count(
                "CREATE FUNCTION f() RETURNS int AS $body$ SELECT '$$'::int $body$",
            ),
        ).toBe(1)
    })

    it("treats $1 as a parameter, not a dollar-quote opener", () => {
        const [statement] = splitStatements(
            "SELECT * FROM t WHERE id = $1; SELECT 2",
            "postgres",
        )
        expect(statement?.tokens.some((token) => token.kind === "param")).toBe(
            true,
        )
        expect(count("SELECT * FROM t WHERE id = $1; SELECT 2")).toBe(2)
    })

    it("does not split inside a line comment", () => {
        expect(count("SELECT 1 --; not a split\n")).toBe(1)
    })

    it("does not split inside a block comment", () => {
        expect(
            count("ALTER TABLE t ADD c text /* ; not a split */ DEFAULT '--x'"),
        ).toBe(1)
    })

    it("nests block comments on Postgres", () => {
        expect(
            count(
                "SELECT 1 /* outer /* inner */ still comment ; */ ; SELECT 2",
            ),
        ).toBe(2)
    })

    it("honours MySQL backslash escapes, which change the statement count", () => {
        // Under MySQL rules the backslash escapes the quote, so the string runs to
        // the trailing comment and the whole thing is one statement. Under Postgres
        // rules the string ends early and it is three.
        const sql = `ALTER TABLE t ADD c varchar(10) DEFAULT 'a\\'; DROP TABLE u; --'`
        expect(count(sql, "mysql")).toBe(1)
        expect(count(sql, "postgres")).toBeGreaterThan(1)
    })

    it("treats # as a comment on MySQL only", () => {
        // MySQL comments out the rest of the line, so the semicolon never splits.
        // Postgres has no # comment, so it does.
        expect(count("SELECT 1 #; SELECT 2", "mysql")).toBe(1)
        expect(count("SELECT 1 #; SELECT 2", "postgres")).toBe(2)
    })

    it("requires whitespace after -- on MySQL", () => {
        // `--x` in MySQL is two negations, not a comment.
        const [statement] = splitStatements("SELECT --x", "mysql")
        expect(
            statement?.tokens.some((token) => token.kind === "operator"),
        ).toBe(true)
    })

    it("reads doubled delimiters inside quoted identifiers", () => {
        const [statement] = splitStatements(
            "ALTER TABLE `weird``name` ADD `co``l` int",
            "mysql",
        )
        const idents =
            statement?.tokens.filter((token) => token.kind === "ident") ?? []
        expect(idents[0]?.value).toBe("weird`name")
        expect(idents[1]?.value).toBe("co`l")
    })

    it("keeps double-quoted text as an identifier on Postgres and a string on MySQL", () => {
        const [pg] = splitStatements('SELECT "a"', "postgres")
        expect(pg?.tokens[1]?.kind).toBe("ident")
        const [my] = splitStatements('SELECT "a"', "mysql")
        expect(my?.tokens[1]?.kind).toBe("string")
    })

    it("retains leading comments so markers survive", () => {
        const [statement] = splitStatements(
            "-- strong-migrations:ignore\nDROP TABLE users",
            "postgres",
        )
        expect(statement?.leadingComments.join("")).toContain(
            "strong-migrations:ignore",
        )
    })

    it("keeps MySQL executable comments in the token stream", () => {
        const [statement] = splitStatements(
            "ALTER TABLE t /*!80000 ALGORITHM=INPLACE */, LOCK=NONE",
            "mysql",
        )
        expect(
            statement?.tokens.some((token) => token.lower === "algorithm"),
        ).toBe(true)
    })

    it("degrades to a lex error rather than throwing on an unterminated string", () => {
        const [statement] = splitStatements("SELECT 'unterminated", "postgres")
        expect(statement?.lexError).toBe(true)
    })

    it("degrades on an unterminated dollar quote", () => {
        const [statement] = splitStatements(
            "CREATE FUNCTION f() AS $$ body",
            "postgres",
        )
        expect(statement?.lexError).toBe(true)
    })
})
