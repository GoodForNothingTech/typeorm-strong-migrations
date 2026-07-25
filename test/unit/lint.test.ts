import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { extractQueryCalls, lintFiles, lintSql } from "../../src/lint"

/**
 * Static linting has no counterpart in the gem, and cannot have one: Rails
 * migrations are Ruby that must execute to be understood. TypeORM migrations carry
 * their DDL as string literals, so CI can check a file before anything connects.
 */
describe("lintSql", () => {
    it("finds an unsafe index in raw SQL", () => {
        const result = lintSql('CREATE INDEX "IDX_a" ON "users" ("email")', {
            dialect: "postgres",
        })
        expect(result.findings.map((finding) => finding.key)).toEqual([
            "createIndex",
        ])
    })

    it("passes the concurrent form", () => {
        const result = lintSql(
            'CREATE INDEX CONCURRENTLY "IDX_a" ON "users" ("email")',
            {
                dialect: "postgres",
            },
        )
        expect(result.findings).toEqual([])
    })

    it("tracks tables created earlier in the same file", () => {
        const result = lintSql(
            'CREATE TABLE "posts" ("id" SERIAL NOT NULL); CREATE INDEX "IDX_a" ON "posts" ("id")',
            { dialect: "postgres" },
        )
        expect(result.findings).toEqual([])
    })

    it("skips checks that need a live database rather than guessing", () => {
        // changeColumn cannot be judged without the current type, so static linting
        // stays silent instead of reporting a maybe.
        const result = lintSql(
            'ALTER TABLE "users" ALTER COLUMN "name" TYPE text',
            {
                dialect: "postgres",
            },
        )
        expect(result.findings).toEqual([])
    })

    it("counts statements it could not interpret", () => {
        const result = lintSql("DO $$ BEGIN END $$", { dialect: "postgres" })
        expect(result.unparsed).toBe(1)
        expect(result.findings[0]?.key).toBe("rawQuery")
    })

    it("ignores TypeORM bookkeeping", () => {
        const result = lintSql(
            `CREATE TABLE "migrations" ("id" SERIAL NOT NULL); INSERT INTO "migrations"("name") VALUES ('a')`,
            { dialect: "postgres" },
        )
        expect(result.findings).toEqual([])
        expect(result.statements).toBe(0)
    })

    it("honours an inline safety marker", () => {
        const result = lintSql(
            '/* strong-migrations:safety-assured */ CREATE INDEX "IDX_a" ON "users" ("email")',
            { dialect: "postgres" },
        )
        expect(result.findings).toEqual([])
    })
})

describe("extractQueryCalls", () => {
    it("pulls SQL out of the shape migration:generate emits", () => {
        const source = [
            "export class AddIndex1700000000000 implements MigrationInterface {",
            "    public async up(queryRunner: QueryRunner): Promise<void> {",
            '        await queryRunner.query(`CREATE INDEX "IDX_a" ON "users" ("email")`);',
            "    }",
            "}",
        ].join("\n")

        const calls = extractQueryCalls(source)
        expect(calls).toHaveLength(1)
        expect(calls[0]?.sql).toBe('CREATE INDEX "IDX_a" ON "users" ("email")')
        expect(calls[0]?.line).toBe(3)
    })

    it("undoes the escaping migration:generate applies to the source file", () => {
        // escapeTemplateLiteral escapes backticks and ${ so the emitted file parses;
        // the driver receives the unescaped text.
        const source =
            "await queryRunner.query(`ALTER TABLE \\`t\\` ADD \\`c\\` int`)"
        expect(extractQueryCalls(source)[0]?.sql).toBe(
            "ALTER TABLE `t` ADD `c` int",
        )
    })
})

describe("lintFiles", () => {
    it("reports findings with file and line, and names the migration", () => {
        const dir = mkdtempSync(join(tmpdir(), "tsm-lint-"))
        const file = join(dir, "1700000000000-AddIndex.ts")
        writeFileSync(
            file,
            [
                'import { MigrationInterface, QueryRunner } from "typeorm";',
                "",
                "export class AddIndex1700000000000 implements MigrationInterface {",
                "    public async up(queryRunner: QueryRunner): Promise<void> {",
                '        await queryRunner.query(`CREATE INDEX "IDX_a" ON "users" ("email")`);',
                "    }",
                "}",
            ].join("\n"),
        )

        const result = lintFiles([file], { dialect: "postgres" })
        expect(result.findings).toHaveLength(1)
        expect(result.findings[0]).toMatchObject({
            key: "createIndex",
            file,
            line: 5,
            migrationName: "AddIndex1700000000000",
        })
    })

    /**
     * A migration is a sequence of separate query() calls, so "created in this
     * migration" has to be tracked across them. Without that, an index on a table
     * created two lines up is reported as unsafe.
     */
    it("carries new-table state across separate query() calls in one file", () => {
        const dir = mkdtempSync(join(tmpdir(), "tsm-lint-"))
        const file = join(dir, "1700000000000-CreateAndIndex.ts")
        writeFileSync(
            file,
            [
                "export class CreateAndIndex1700000000000 implements MigrationInterface {",
                "    public async up(queryRunner: QueryRunner): Promise<void> {",
                '        await queryRunner.query(`CREATE TABLE "posts" ("id" SERIAL NOT NULL)`);',
                '        await queryRunner.query(`CREATE INDEX "IDX_posts_id" ON "posts" ("id")`);',
                '        await queryRunner.query(`CREATE INDEX "IDX_users_email" ON "users" ("email")`);',
                "    }",
                "}",
            ].join("\n"),
        )

        const result = lintFiles([file], { dialect: "postgres" })
        // Only the index on the pre-existing table is reported.
        expect(result.findings).toHaveLength(1)
        expect(result.findings[0]?.line).toBe(5)
    })

    it("skips a file it cannot read instead of failing the run", () => {
        expect(() =>
            lintFiles(["/definitely/not/here.ts"], { dialect: "postgres" }),
        ).not.toThrow()
    })
})
