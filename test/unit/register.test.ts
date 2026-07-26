import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"

/**
 * `register.ts` patches `DataSource.prototype` for the whole process, so it cannot be
 * exercised in-process alongside other tests. It is also where the nastiest bug lived:
 * the prototype patch and the per-instance patch wrapped each other, so *any*
 * `initialize()` blew the stack and the entry point was completely non-functional.
 *
 * Each case runs in its own node process against the built output, which is what a
 * consumer actually loads.
 */

let counter = 0

/**
 * These test the *built* artifact, so they need `dist/`. It happens to exist on a
 * machine that has run a build, which is why this passed locally and failed in CI —
 * `npm test` does not build.
 *
 * Building here rather than skipping when `dist/` is missing: a test that quietly
 * skips in CI is the same failure mode as the interception guard that read a source
 * checkout absent from the runner. It reported success while testing nothing.
 */
beforeAll(() => {
    const entry = join(process.cwd(), "dist/cjs/register.js")
    if (existsSync(entry)) return
    execFileSync("npm", ["run", "build"], {
        cwd: process.cwd(),
        stdio: "inherit",
        timeout: 300_000,
    })
    if (!existsSync(entry)) {
        throw new Error(`Build completed but ${entry} is missing`)
    }
}, 300_000)

/**
 * Written inside the repo rather than a tmpdir, so `typeorm` resolves from the real
 * node_modules — which is also how a consumer would load it.
 */
function runScript(body: string): { stdout: string; status: number } {
    const root = process.cwd()
    const dir = join(root, ".tmp-register")
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `script-${counter++}.mjs`)
    writeFileSync(file, body.replaceAll("__ROOT__", root))
    try {
        const stdout = execFileSync(process.execPath, [file], {
            encoding: "utf8",
            timeout: 30_000,
            cwd: root,
        })
        return { stdout, status: 0 }
    } catch (error) {
        const failure = error as {
            stdout?: string
            stderr?: string
            status?: number
        }
        return {
            stdout: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
            status: failure.status ?? 1,
        }
    } finally {
        rmSync(file, { force: true })
    }
}

/** A DataSource pointed at a closed port: it must fail to connect, not recurse. */
const CONNECT_ATTEMPT = `
const { DataSource } = await import("typeorm")
await import("__ROOT__/dist/cjs/register.js")
const { installStrongMigrations } = await import("__ROOT__/dist/cjs/index.js")

const options = {
    type: "postgres",
    host: "127.0.0.1",
    port: 1,
    username: "x",
    password: "x",
    database: "x",
}
`

describe("register entry point", () => {
    it("does not recurse when only the prototype patch is active", () => {
        const result = runScript(`${CONNECT_ATTEMPT}
try {
    await new DataSource(options).initialize()
    console.log("CONNECTED")
} catch (error) {
    console.log(error instanceof RangeError ? "RECURSION" : "REACHED_CONNECT")
}
`)
        expect(result.stdout.trim()).toBe("REACHED_CONNECT")
    })

    it("does not recurse when combined with an explicit install", () => {
        const result = runScript(`${CONNECT_ATTEMPT}
try {
    await installStrongMigrations(new DataSource(options)).initialize()
    console.log("CONNECTED")
} catch (error) {
    console.log(error instanceof RangeError ? "RECURSION" : "REACHED_CONNECT")
}
`)
        expect(result.stdout.trim()).toBe("REACHED_CONNECT")
    })

    it("does not recurse when installed twice", () => {
        const result = runScript(`${CONNECT_ATTEMPT}
try {
    const ds = installStrongMigrations(new DataSource(options))
    await installStrongMigrations(ds).initialize()
    console.log("CONNECTED")
} catch (error) {
    console.log(error instanceof RangeError ? "RECURSION" : "REACHED_CONNECT")
}
`)
        expect(result.stdout.trim()).toBe("REACHED_CONNECT")
    })

    it("registers the DataSource so its migrations would be checked", () => {
        const result = runScript(`${CONNECT_ATTEMPT}
const { isInstalled } = await import("__ROOT__/dist/cjs/index.js")
const ds = new DataSource(options)
try { await ds.initialize() } catch {}
console.log(isInstalled(ds) ? "INSTALLED" : "NOT_INSTALLED")
`)
        expect(result.stdout.trim()).toBe("INSTALLED")
    })

    it("is safe to import more than once", () => {
        const result = runScript(`${CONNECT_ATTEMPT}
await import("__ROOT__/dist/cjs/register.js")
await import("__ROOT__/dist/cjs/register.js")
try {
    await new DataSource(options).initialize()
    console.log("CONNECTED")
} catch (error) {
    console.log(error instanceof RangeError ? "RECURSION" : "REACHED_CONNECT")
}
`)
        expect(result.stdout.trim()).toBe("REACHED_CONNECT")
    })
})
