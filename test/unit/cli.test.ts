import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { CliIo } from "../../src/cli"
import {
    discoverConfigFile,
    loadConfigFile,
    parseArgs,
    runCli,
} from "../../src/cli"

/**
 * The CLI had no tests at all, which is how it shipped with an exit code that lied.
 * `runCli` returns a code instead of calling `process.exit`, so it is callable here —
 * and so that buffered stdout is flushed before the process ends, which `process.exit`
 * does not do.
 */

function capture(): CliIo & { stdout: string[]; stderr: string[] } {
    const stdout: string[] = []
    const stderr: string[] = []
    return {
        stdout,
        stderr,
        out: (line) => stdout.push(line),
        err: (line) => stderr.push(line),
        cwd: () => tmpdir(),
    }
}

function migrationDir(body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "tsm-cli-"))
    writeFileSync(
        join(dir, "1700000000000-Test.ts"),
        [
            "export class Test1700000000000 implements MigrationInterface {",
            "    public async up(queryRunner: QueryRunner): Promise<void> {",
            `        ${body}`,
            "    }",
            "}",
        ].join("\n"),
    )
    return dir
}

describe("exit codes", () => {
    /**
     * The bug: `collectFiles` set exitCode 2 for a missing path, then the "no issues
     * found" branch called `process.exit(0)` and overrode it. CI reported success
     * having linted nothing.
     */
    it("returns 2 for a path that does not exist", () => {
        const io = capture()
        expect(runCli(["check", "/definitely/not/here"], io)).toBe(2)
        expect(io.stderr.join("\n")).toContain("Not found")
    })

    it("does not claim success when a path was missing", () => {
        const io = capture()
        runCli(["check", "/definitely/not/here"], io)
        expect(io.stdout.join("\n")).not.toContain("No issues found")
    })

    it("returns 1 when a finding is reported", () => {
        const dir = migrationDir(
            'await queryRunner.query(`CREATE INDEX "IDX_a" ON "users" ("email")`);',
        )
        expect(runCli(["check", dir], capture())).toBe(1)
    })

    it("returns 0 for a clean migration", () => {
        const dir = migrationDir(
            'await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_a" ON "users" ("email")`);',
        )
        expect(runCli(["check", dir], capture())).toBe(0)
    })

    /** Silently passing an empty directory is how a misconfigured CI stays green. */
    it("returns 2 when no migration files matched", () => {
        const dir = mkdtempSync(join(tmpdir(), "tsm-cli-empty-"))
        const io = capture()
        expect(runCli(["check", dir], io)).toBe(2)
        expect(io.stderr.join("\n")).toContain("No migration files found")
    })

    it("returns 2 for bad usage and 0 for help", () => {
        expect(runCli([], capture())).toBe(2)
        expect(runCli(["--help"], capture())).toBe(0)
        expect(runCli(["bogus"], capture())).toBe(2)
        expect(runCli(["check"], capture())).toBe(2)
        expect(runCli(["check", ".", "--dialect", "oracle"], capture())).toBe(2)
        expect(runCli(["check", ".", "--nope"], capture())).toBe(2)
    })

    it("prints a version", () => {
        const io = capture()
        expect(runCli(["--version"], io)).toBe(0)
        expect(io.stdout.join("")).toMatch(/^\d+\.\d+\.\d+|unknown$/)
    })
})

describe("json output", () => {
    it("emits a single parseable document", () => {
        const dir = migrationDir(
            'await queryRunner.query(`CREATE INDEX "IDX_a" ON "users" ("email")`);',
        )
        const io = capture()
        runCli(["check", dir, "--json"], io)
        const parsed = JSON.parse(io.stdout.join("\n")) as {
            findings: unknown[]
        }
        expect(parsed.findings.length).toBeGreaterThan(0)
    })

    it("reports missing paths in the payload rather than only on stderr", () => {
        const io = capture()
        const code = runCli(["check", "/definitely/not/here", "--json"], io)
        expect(code).toBe(2)
        expect(JSON.parse(io.stdout.join("\n"))).toMatchObject({
            missing: ["/definitely/not/here"],
        })
    })
})

describe("configuration", () => {
    /**
     * The CLI used to ignore configuration entirely, so a check could not be silenced
     * in CI — while the output cheerfully referred to "your unknownSql setting".
     */
    it("honours a check disabled in a config file", () => {
        const dir = migrationDir(
            'await queryRunner.query(`CREATE INDEX "IDX_a" ON "users" ("email")`);',
        )
        const file = join(dir, "1700000000000-Test.ts")
        const configPath = join(dir, "sm.json")
        writeFileSync(
            configPath,
            JSON.stringify({ enabledChecks: { createIndex: false } }),
        )

        // Same file, same statement — the only difference is the config.
        expect(runCli(["check", file], capture())).toBe(1)
        expect(runCli(["check", file, "--config", configPath], capture())).toBe(
            0,
        )
    })

    it("accepts the gem's snake_case key in a config file", () => {
        const dir = migrationDir(
            'await queryRunner.query(`CREATE INDEX "IDX_a" ON "users" ("email")`);',
        )
        const file = join(dir, "1700000000000-Test.ts")
        const configPath = join(dir, "sm.json")
        writeFileSync(
            configPath,
            JSON.stringify({ enabledChecks: { add_index: false } }),
        )
        expect(runCli(["check", file, "--config", configPath], capture())).toBe(
            0,
        )
    })

    it("fails clearly when the named config does not exist", () => {
        const io = capture()
        expect(
            runCli(["check", ".", "--config", "/no/such/config.json"], io),
        ).toBe(2)
        expect(io.stderr.join("\n")).toContain("Config file not found")
    })

    it("reads a JSON config file", () => {
        const dir = mkdtempSync(join(tmpdir(), "tsm-cfg-"))
        const path = join(dir, "strong-migrations.config.json")
        writeFileSync(path, JSON.stringify({ startAfter: 42 }))
        expect(loadConfigFile(path)).toEqual({ startAfter: 42 })
    })

    it("discovers a config file by walking up", () => {
        const root = mkdtempSync(join(tmpdir(), "tsm-discover-"))
        const path = join(root, "strong-migrations.config.json")
        writeFileSync(path, JSON.stringify({ startAfter: 1 }))
        expect(discoverConfigFile(root)).toBe(path)
    })

    /** Custom migrations table names were unreachable, so the CLI linted our own DDL. */
    it("does not flag bookkeeping under a custom migrations table name", () => {
        const dir = migrationDir(
            'await queryRunner.query(`DROP TABLE "_migrations"`);',
        )
        const file = join(dir, "1700000000000-Test.ts")
        expect(runCli(["check", file], capture())).toBe(1)
        expect(
            runCli(
                ["check", file, "--migrations-table", "_migrations"],
                capture(),
            ),
        ).toBe(0)
    })
})

describe("argument parsing", () => {
    it("collects paths and options", () => {
        const parsed = parseArgs(["a", "b", "--dialect", "mysql", "--json"])
        expect(parsed).toMatchObject({
            kind: "options",
            options: { paths: ["a", "b"], dialect: "mysql", json: true },
        })
    })

    it("rejects an unknown option instead of treating it as a path", () => {
        expect(parseArgs(["--wat"])).toMatchObject({ kind: "error" })
    })

    it("rejects a flag that is missing its value", () => {
        expect(parseArgs(["--config"])).toMatchObject({ kind: "error" })
        expect(parseArgs(["--dialect"])).toMatchObject({ kind: "error" })
    })
})
