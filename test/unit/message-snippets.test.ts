import ts from "typescript"
import { describe, expect, it } from "vitest"
import { CHECK_KEYS } from "../../src/checks/keys"
import { ERROR_MESSAGES } from "../../src/messages/error-messages"
import { interpolate } from "../../src/messages/format"

/**
 * Compiles every code block we tell people to write, against the installed TypeORM
 * types.
 *
 * The gem cannot do this — Ruby has no compiler — and it is the single biggest
 * quality advantage of the port. If `TableIndex` loses `isConcurrent`, or
 * `UpdateResult.affected` changes shape, or a snippet has a typo, this fails on the
 * TypeORM-version matrix in CI rather than after someone pastes broken advice into
 * a migration.
 */

const PLACEHOLDER_VALUES: Record<string, string> = {
    migrationName: "ExampleMigration1700000000000",
    baseName: "Example",
    nextTimestamp: "1700000000001",
    entity: "User",
    property: "email: string",
    columns: '"email"',
    tableName: '"users"',
    lockType: "shared",
    lockBlocks: "reads",
    rewriteBlocks: "reads and writes",
    defaultType: "volatile",
    default: "gen_random_uuid()",
    mode: "all",
    declared: "false",
    append: "",
    cause: "",
    remedy: "Set `public transaction = false`.",
    sql: 'ALTER TABLE "users" DROP COLUMN "email"',
    code: 'await queryRunner.query(`UPDATE "users" SET "active" = true`)',
    command: 'await queryRunner.query(`ALTER TABLE "users" ADD "x" integer`)',
    downCommand: 'await queryRunner.query(`DROP INDEX "IDX_users_name"`)',
    addCommand:
        'await queryRunner.query(`ALTER TABLE "users" ADD "x" integer`)',
    changeCommand:
        'await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "x" SET DEFAULT 1`)',
    removeCommand:
        'await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "x"`)',
    indexCommand:
        'await queryRunner.query(`CREATE UNIQUE INDEX CONCURRENTLY "IDX_a" ON "users" ("email")`)',
    constraintCommand:
        'await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "UQ_a" UNIQUE USING INDEX "IDX_a"`)',
    addConstraintCode:
        'await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "c" CHECK ("x" IS NOT NULL) NOT VALID`)',
    removeConstraintCode:
        'await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "c"`)',
    validateConstraintCode:
        'await queryRunner.query(`ALTER TABLE "users" VALIDATE CONSTRAINT "c"`)',
    changeColumnCode:
        'await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "x" TYPE text`)',
    addForeignKeyCode:
        'await queryRunner.query(`ALTER TABLE "a" ADD CONSTRAINT "fk" FOREIGN KEY ("b") REFERENCES "c" ("id") NOT VALID`)',
    removeForeignKeyCode:
        'await queryRunner.query(`ALTER TABLE "a" DROP CONSTRAINT "fk"`)',
    validateForeignKeyCode:
        'await queryRunner.query(`ALTER TABLE "a" VALIDATE CONSTRAINT "fk"`)',
    addCheckConstraintCode:
        'await queryRunner.query(`ALTER TABLE "users" ADD CONSTRAINT "c" CHECK (age > 0) NOT VALID`)',
    removeCheckConstraintCode:
        'await queryRunner.query(`ALTER TABLE "users" DROP CONSTRAINT "c"`)',
    validateCheckConstraintCode:
        'await queryRunner.query(`ALTER TABLE "users" VALIDATE CONSTRAINT "c"`)',
}

const PREAMBLE = `
import type { MigrationInterface, QueryRunner } from "typeorm"
import { TableIndex, TableColumn, DataSource, Entity, Column } from "typeorm"
declare function safetyAssured<T>(fn: () => T | PromiseLike<T>): Promise<T>
declare const queryRunner: QueryRunner
export {}
`

/**
 * Two templates wrap their command in `safetyAssured(() => ...)`, so the command
 * they interpolate must be an expression rather than a statement with `await`.
 */
const PER_KEY_OVERRIDES: Partial<Record<string, Record<string, string>>> = {
    dropTable: { command: 'queryRunner.dropTable("users")' },
    truncate: { command: 'queryRunner.clearTable("users")' },
    // These interpolate into call arguments, so the placeholder must be a valid
    // TypeScript expression rather than the generic <name> marker.
    dropSchema: { schema: '"legacy"' },
    dropView: { viewName: '"active_users"' },
    changeColumnDefault: { default: '"active"', property: "email!: string" },
    // Here {{code}} is an entity property being deleted, not a migration statement.
    dropColumn: {
        command: 'queryRunner.query(`ALTER TABLE "users" DROP COLUMN "email"`)',
        code: "@Column()\n    email!: string",
    },
}

/**
 * Pulls out the `export class ... { ... }` blocks and the standalone
 * `export const AppDataSource = ...` block, which is everything in a message that
 * claims to be compilable TypeScript.
 */
function extractSnippets(rendered: string): string[] {
    const snippets: string[] = []
    const lines = rendered.split("\n")
    let current: string[] | undefined

    for (const line of lines) {
        if (/^export (class|const) /.test(line)) {
            if (current) snippets.push(current.join("\n"))
            current = [line]
            continue
        }
        if (!current) continue
        current.push(line)
        // A block ends at a closing brace or `})` in column zero.
        if (/^(\}|\}\))$/.test(line)) {
            snippets.push(current.join("\n"))
            current = undefined
        }
    }
    if (current) snippets.push(current.join("\n"))
    return snippets
}

function compile(source: string): string[] {
    const fileName = "snippet.ts"
    const sourceFile = ts.createSourceFile(
        fileName,
        source,
        ts.ScriptTarget.ES2022,
        true,
    )

    const host = ts.createCompilerHost({}, true)
    const originalGetSourceFile = host.getSourceFile.bind(host)
    host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
        name === fileName
            ? sourceFile
            : originalGetSourceFile(
                  name,
                  languageVersion,
                  onError,
                  shouldCreate,
              )
    host.writeFile = () => {}

    const program = ts.createProgram({
        rootNames: [fileName],
        options: {
            noEmit: true,
            strict: true,
            skipLibCheck: true,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.CommonJS,
            moduleResolution: ts.ModuleResolutionKind.Node10,
            experimentalDecorators: true,
            // Matches TypeORM's own tsconfig, which is what a consumer's entity
            // classes are compiled under.
            strictPropertyInitialization: false,
            useDefineForClassFields: false,
            types: [],
        },
        host,
    })

    return ts
        .getPreEmitDiagnostics(program)
        .filter((diagnostic) => diagnostic.file?.fileName === fileName)
        .map((diagnostic) =>
            ts.flattenDiagnosticMessageText(diagnostic.messageText, " "),
        )
}

describe("message code snippets", () => {
    for (const key of CHECK_KEYS) {
        it(`${key} shows code that type-checks against the installed TypeORM`, () => {
            const rendered = interpolate(ERROR_MESSAGES[key], {
                ...PLACEHOLDER_VALUES,
                ...PER_KEY_OVERRIDES[key],
            })
            const snippets = extractSnippets(rendered)
            if (snippets.length === 0) return

            for (const snippet of snippets) {
                // A snippet with an explicit `// ...` elision is showing a fragment of
                // the reader's own config, not something to paste whole, so it cannot
                // be expected to compile standalone.
                if (snippet.includes("// ...")) continue
                const errors = compile(`${PREAMBLE}\n${snippet}\n`)
                expect(
                    errors,
                    `${key}\n\n${snippet}\n\nerrors: ${errors.join("; ")}`,
                ).toEqual([])
            }
        })
    }

    it("actually rejects a broken snippet, so the harness is not vacuous", () => {
        const errors = compile(
            `${PREAMBLE}\nexport const x: number = "not a number"\n`,
        )
        expect(errors.length).toBeGreaterThan(0)
    })

    it("proves TableIndex.isConcurrent exists, which the safe index form depends on", () => {
        const errors = compile(
            `${PREAMBLE}\nexport const i = new TableIndex({ name: "a", columnNames: ["b"], isConcurrent: true })\n`,
        )
        expect(errors).toEqual([])
    })
})
