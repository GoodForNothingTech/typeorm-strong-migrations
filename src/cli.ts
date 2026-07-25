#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { ResolvedConfig, StrongMigrationsConfig } from "./config"
import { baseConfig, mergeConfig } from "./config"
import { banner, StrongMigrationsConfigError } from "./errors"
import { lintFiles } from "./lint"
import type { Dialect } from "./operations/types"

/**
 * Static linting for CI: the same checks, run over migration source files with no
 * database connection.
 *
 * This has no counterpart in the gem, and cannot have one — Rails migrations are
 * Ruby that must execute to be understood. TypeORM migrations carry their DDL as
 * string literals, so a file can be checked before anything connects.
 */

export interface CliOptions {
    paths: string[]
    dialect: Dialect
    json: boolean
    configPath?: string
    migrationsTableName?: string
    metadataTableName?: string
}

export interface CliIo {
    out(line: string): void
    err(line: string): void
    cwd(): string
}

const defaultIo: CliIo = {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    cwd: () => process.cwd(),
}

export const HELP = `typeorm-strong-migrations check — lint TypeORM migrations without a database

Usage:
  typeorm-strong-migrations check <path...> [options]

Arguments:
  <path...>              Migration files or directories to scan.

Options:
  -d, --dialect          postgres | mysql | mariadb. Default: postgres
      --config <path>    Config file. Otherwise strong-migrations.config.{ts,js,json,mjs,cjs}
                         is looked for next to package.json.
      --migrations-table Name of the migrations table, if not "migrations".
      --json             Emit findings as JSON.
  -v, --version          Print the version.
  -h, --help             Show this message.

Exit codes:
  0  no findings
  1  at least one unsafe operation
  2  bad usage, or a path that does not exist
`

const CONFIG_NAMES = [
    "strong-migrations.config.ts",
    "strong-migrations.config.mts",
    "strong-migrations.config.js",
    "strong-migrations.config.mjs",
    "strong-migrations.config.cjs",
    "strong-migrations.config.json",
]

type ParseResult =
    | { kind: "options"; options: CliOptions }
    | { kind: "help" }
    | { kind: "version" }
    | { kind: "error"; message: string }

export function parseArgs(argv: string[]): ParseResult {
    const paths: string[] = []
    let dialect: Dialect = "postgres"
    let json = false
    let configPath: string | undefined
    let migrationsTableName: string | undefined

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!
        if (arg === "--help" || arg === "-h") return { kind: "help" }
        if (arg === "--version" || arg === "-v") return { kind: "version" }
        if (arg === "--json") {
            json = true
            continue
        }
        if (arg === "--dialect" || arg === "-d") {
            const value = argv[++index]
            if (
                value === "postgres" ||
                value === "mysql" ||
                value === "mariadb"
            ) {
                dialect = value
                continue
            }
            return {
                kind: "error",
                message: `Unknown dialect: ${value ?? "(missing)"}. Expected postgres, mysql or mariadb.`,
            }
        }
        if (arg === "--config") {
            const value = argv[++index]
            if (!value)
                return { kind: "error", message: "--config needs a path." }
            configPath = value
            continue
        }
        if (arg === "--migrations-table") {
            const value = argv[++index]
            if (!value)
                return {
                    kind: "error",
                    message: "--migrations-table needs a name.",
                }
            migrationsTableName = value
            continue
        }
        if (arg.startsWith("-")) {
            return { kind: "error", message: `Unknown option: ${arg}` }
        }
        paths.push(arg)
    }

    return {
        kind: "options",
        options: { paths, dialect, json, configPath, migrationsTableName },
    }
}

/**
 * Loads config from disk.
 *
 * JSON is read directly; a `.js`/`.cjs`/`.mjs` file is required. A `.ts` file needs a
 * loader in the host process (tsx, ts-node), so rather than pulling one in we say so
 * and let the caller point at a JSON file or run through their own loader.
 */
export function loadConfigFile(path: string): StrongMigrationsConfig {
    const absolute = resolve(path)
    if (!existsSync(absolute)) {
        throw new StrongMigrationsConfigError(`Config file not found: ${path}`)
    }
    if (absolute.endsWith(".json")) {
        return JSON.parse(
            readFileSync(absolute, "utf8"),
        ) as StrongMigrationsConfig
    }
    if (/\.m?ts$/.test(absolute)) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const loaded = require(absolute) as {
                default?: StrongMigrationsConfig
            } & StrongMigrationsConfig
            return loaded.default ?? loaded
        } catch (error) {
            throw new StrongMigrationsConfigError(
                `Could not load ${path}: ${(error as Error).message}\n` +
                    "TypeScript config needs a loader in this process. Either run the CLI " +
                    "through tsx/ts-node, or point --config at a .json or .js file.",
            )
        }
    }
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const loaded = require(absolute) as {
        default?: StrongMigrationsConfig
    } & StrongMigrationsConfig
    return loaded.default ?? loaded
}

/** Walks up from `start` looking for a config file beside a package.json. */
export function discoverConfigFile(start: string): string | undefined {
    let directory = resolve(start)
    for (;;) {
        for (const name of CONFIG_NAMES) {
            const candidate = join(directory, name)
            if (existsSync(candidate)) return candidate
        }
        const parent = dirname(directory)
        if (parent === directory) return undefined
        directory = parent
    }
}

function collectFiles(
    paths: string[],
    io: CliIo,
): { files: string[]; missing: string[] } {
    const files: string[] = []
    const missing: string[] = []

    const visit = (target: string): void => {
        const full = resolve(target)
        let stats
        try {
            stats = statSync(full)
        } catch {
            missing.push(target)
            return
        }
        if (stats.isDirectory()) {
            for (const entry of readdirSync(full)) visit(join(full, entry))
            return
        }
        if (/\.(ts|js|mts|cts|mjs|cjs)$/.test(full) && !/\.d\.ts$/.test(full)) {
            files.push(full)
        }
    }

    for (const path of paths) visit(path)
    void io
    return { files, missing }
}

function packageVersion(): string {
    try {
        const manifest = resolve(__dirname, "../../package.json")
        return (
            JSON.parse(readFileSync(manifest, "utf8")) as { version: string }
        ).version
    } catch {
        return "unknown"
    }
}

/**
 * Returns the exit code rather than calling `process.exit`.
 *
 * `process.exit` does not flush asynchronous stdout, so piping `--json` to a file or
 * to `jq` truncated the payload mid-object. It also used to override the exit code
 * already set for a missing path, so `check ./typo` reported the problem and then
 * exited 0 — CI went green having linted nothing.
 */
export function runCli(argv: string[], io: CliIo = defaultIo): number {
    const [command, ...rest] = argv

    if (!command) {
        io.out(HELP)
        return 2
    }
    if (command === "--help" || command === "-h") {
        io.out(HELP)
        return 0
    }
    if (command === "--version" || command === "-v") {
        io.out(packageVersion())
        return 0
    }
    if (command !== "check") {
        io.err(`Unknown command: ${command}\n`)
        io.err(HELP)
        return 2
    }

    const parsed = parseArgs(rest)
    if (parsed.kind === "help") {
        io.out(HELP)
        return 0
    }
    if (parsed.kind === "version") {
        io.out(packageVersion())
        return 0
    }
    if (parsed.kind === "error") {
        io.err(parsed.message)
        return 2
    }

    const options = parsed.options
    if (options.paths.length === 0) {
        io.err("No paths given.\n")
        io.err(HELP)
        return 2
    }

    let config: ResolvedConfig
    try {
        const path = options.configPath ?? discoverConfigFile(io.cwd())
        const loaded = path ? loadConfigFile(path) : {}
        config = mergeConfig(baseConfig(), loaded)
        if (path && !options.json) io.out(`Using config ${path}`)
    } catch (error) {
        io.err((error as Error).message)
        return 2
    }

    const { files, missing } = collectFiles(options.paths, io)
    for (const path of missing) io.err(`Not found: ${path}`)

    const result = lintFiles(files, {
        dialect: options.dialect,
        config,
        migrationsTableName: options.migrationsTableName,
    })

    if (options.json) {
        io.out(JSON.stringify({ ...result, missing }, null, 2))
        return missing.length > 0 ? 2 : result.findings.length > 0 ? 1 : 0
    }

    for (const finding of result.findings) {
        const location = finding.file
            ? `${finding.file}:${finding.line ?? 1}`
            : "<input>"
        io.err(`${location}\n${banner(finding.header, finding.message)}`)
    }

    // A path that does not exist is a usage error, not a clean run — reporting "no
    // issues found" for a typo'd directory is how a linter goes green by accident.
    if (missing.length > 0) return 2

    const scanned = `${files.length} file${files.length === 1 ? "" : "s"}`
    if (result.findings.length === 0) {
        if (files.length === 0) {
            io.err(
                `No migration files found in ${options.paths.join(", ")}. ` +
                    "Nothing was checked.",
            )
            return 2
        }
        io.out(
            `Checked ${scanned}, ${result.statements} statements. No issues found.`,
        )
        if (result.unparsed > 0) {
            io.out(
                `${result.unparsed} statement(s) could not be fully analyzed. ` +
                    "Re-run with unknownSql/partialSql configured to see them.",
            )
        }
        return 0
    }

    io.err(
        `Checked ${scanned}, ${result.statements} statements. ` +
            `${result.findings.length} issue(s) found.`,
    )
    return 1
}

/* c8 ignore start -- entry point */
if (require.main === module) {
    // Set the code and let the event loop drain, so buffered stdout is flushed.
    process.exitCode = runCli(process.argv.slice(2))
}
/* c8 ignore stop */
