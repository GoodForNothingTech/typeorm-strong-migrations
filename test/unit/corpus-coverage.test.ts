import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { analyzeSql } from "../../src/sql/analyze"
import { MYSQL_CORPUS, POSTGRES_CORPUS } from "./analyzer-corpus.test"

interface Template {
    id: string
    file: string
    line: number
    text: string
    head: string
}

/**
 * Keeps the port honest across TypeORM upgrades.
 *
 * `npm run corpus:extract` walks TypeORM's query runners with the TypeScript
 * compiler API and records every DDL template literal. This test asserts each
 * distinct statement shape is represented by a fixture in the hand-authored
 * corpus, naming file:line for any that is not — so a new TypeORM release surfaces
 * as a concrete list of gaps rather than as migrations quietly going unchecked.
 *
 * It is skipped when the generated file is absent, since regenerating it needs a
 * TypeORM checkout beside the package.
 */
const CORPUS_FILE = resolve(process.cwd(), "test/corpus/templates.json")

/** Head plus the next keyword: "alter table", "create index", "comment on". */
function shapeOf(sql: string): string {
    const words = sql
        .replace(/[`"]/g, "")
        .split(/[\s(]+/)
        .filter(Boolean)
        .map((word) => word.toLowerCase())

    const head = words[0] ?? ""
    // Modifiers sit between the verb and the object.
    const skip = new Set([
        "unique",
        "concurrently",
        "if",
        "not",
        "exists",
        "or",
        "replace",
        "temporary",
        "temp",
        "unlogged",
        "materialized",
        "fulltext",
        "spatial",
        "only",
    ])
    for (const word of words.slice(1)) {
        if (skip.has(word)) continue
        return `${head} ${word}`
    }
    return head
}

describe("TypeORM DDL corpus coverage", () => {
    const available = existsSync(CORPUS_FILE)

    it.skipIf(!available)(
        "covers every statement shape TypeORM's query runners emit",
        () => {
            const { templates } = JSON.parse(
                readFileSync(CORPUS_FILE, "utf8"),
            ) as {
                templates: Template[]
            }

            const covered = new Set(
                [...POSTGRES_CORPUS, ...MYSQL_CORPUS].flatMap((sql) =>
                    sql
                        .split(";")
                        .map((statement) => shapeOf(statement.trim())),
                ),
            )

            const uncovered = new Map<string, Template>()
            for (const template of templates) {
                const shape = shapeOf(template.text)
                // A hole in the leading position leaves nothing to classify.
                if (shape.includes("${...}")) continue
                if (covered.has(shape)) continue
                if (!uncovered.has(shape)) uncovered.set(shape, template)
            }

            const report = [...uncovered.entries()].map(
                ([shape, template]) =>
                    `${shape}  (${template.file}:${template.line})`,
            )
            expect(
                report,
                `TypeORM emits statement shapes with no fixture in analyzer-corpus.test.ts:\n${report.join("\n")}`,
            ).toEqual([])
        },
    )

    it.skipIf(!available)(
        "parses every fixture without falling back to unknown",
        () => {
            const unparsed = [
                ...POSTGRES_CORPUS.flatMap((sql) =>
                    analyzeSql(sql, "postgres"),
                ),
                ...MYSQL_CORPUS.flatMap((sql) => analyzeSql(sql, "mysql")),
            ].filter((op) => op.kind === "unknown")

            expect(unparsed).toEqual([])
        },
    )
})
