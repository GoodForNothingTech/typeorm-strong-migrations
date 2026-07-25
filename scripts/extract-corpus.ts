/**
 * Extracts every SQL template literal from TypeORM's query runners, so the
 * analyzer's corpus can be checked against what TypeORM actually emits rather
 * than against what we remember it emitting.
 *
 * Run after bumping the pinned TypeORM version:
 *
 *     npm run corpus:extract
 *
 * It writes test/corpus/templates.json. The corpus test reads that file and fails
 * for any DDL template shape no fixture covers, naming the file and line — which
 * is how a new TypeORM release surfaces as a concrete gap instead of a silent one.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import ts from "typescript"

interface Template {
    id: string
    file: string
    line: number
    /** Template text with `${...}` holes replaced by a marker. */
    text: string
    head: string
}

const DDL_HEADS = new Set([
    "alter",
    "create",
    "drop",
    "rename",
    "truncate",
    "comment",
    "reindex",
])

/**
 * The reference checkout sits beside this package. It is a developer convenience,
 * not a dependency, so a missing checkout is a clear message rather than a crash.
 */
const TYPEORM_SRC = resolve(process.cwd(), "typeorm/src")

const TARGETS = [
    "driver/postgres/PostgresQueryRunner.ts",
    "driver/mysql/MysqlQueryRunner.ts",
    "driver/cockroachdb/CockroachQueryRunner.ts",
]

function templateText(
    node: ts.Node,
    source: ts.SourceFile,
): string | undefined {
    if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text
    if (!ts.isTemplateExpression(node)) return undefined

    let text = node.head.text
    for (const span of node.templateSpans) {
        // Holes are opaque; mark them so shape matching still works.
        text += `\${...}${span.literal.text}`
    }
    void source
    return text
}

function firstKeyword(text: string): string {
    const match = /^[\s(]*([A-Za-z]+)/.exec(text)
    return match ? match[1]!.toLowerCase() : ""
}

function extract(file: string): Template[] {
    const absolute = join(TYPEORM_SRC, file)
    if (!existsSync(absolute)) return []

    const program = ts.createSourceFile(
        absolute,
        require("node:fs").readFileSync(absolute, "utf8"),
        ts.ScriptTarget.ES2022,
        true,
    )

    const found: Template[] = []
    const visit = (node: ts.Node): void => {
        const text = templateText(node, program)
        if (text) {
            const head = firstKeyword(text)
            if (DDL_HEADS.has(head)) {
                const { line } = program.getLineAndCharacterOfPosition(
                    node.getStart(),
                )
                found.push({
                    id: `${file}:${line + 1}`,
                    file,
                    line: line + 1,
                    text: text.replace(/\s+/g, " ").trim(),
                    head,
                })
            }
        }
        ts.forEachChild(node, visit)
    }
    ts.forEachChild(program, visit)
    return found
}

function main(): void {
    if (!existsSync(TYPEORM_SRC)) {
        console.error(
            `No TypeORM checkout at ${TYPEORM_SRC}.\n` +
                "Clone typeorm/typeorm beside this package to regenerate the corpus.",
        )
        process.exit(1)
    }

    const templates = TARGETS.flatMap(extract)
    if (templates.length === 0) {
        console.error(
            "Found no DDL templates — the TypeORM layout may have changed.",
        )
        process.exit(1)
    }

    const output = resolve(process.cwd(), "test/corpus/templates.json")
    mkdirSync(dirname(output), { recursive: true })
    writeFileSync(output, `${JSON.stringify({ templates }, null, 2)}\n`)

    const byHead = new Map<string, number>()
    for (const template of templates) {
        byHead.set(template.head, (byHead.get(template.head) ?? 0) + 1)
    }

    console.log(`Wrote ${templates.length} DDL templates to ${output}`)
    for (const [head, count] of [...byHead].sort()) {
        console.log(`  ${head.padEnd(10)} ${count}`)
    }
}

main()
