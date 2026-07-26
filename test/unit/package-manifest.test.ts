import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

/**
 * npm silently rewrites parts of package.json at publish time. When it does, it warns
 * — in the middle of a several-hundred-line tarball listing that nobody reads — and
 * publishes the corrected version anyway.
 *
 * That is how `bin` nearly shipped stripped: the value was `./dist/cjs/cli.js`, npm
 * reported `script name dist/cjs/cli.js was invalid and removed`, and `npm pack` +
 * a local install still worked, so nothing caught it. These assertions encode the
 * normalized form so the manifest cannot drift back.
 */

const manifest = JSON.parse(
    readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
) as {
    name: string
    version: string
    license: string
    files: string[]
    bin: Record<string, string>
    main: string
    types: string
    exports: Record<string, unknown>
    repository: { url: string }
    peerDependencies: Record<string, string>
    dependencies?: Record<string, string>
}

const runtimeDependencies = (): Record<string, string> =>
    manifest.dependencies ?? {}

describe("package manifest", () => {
    /**
     * The asymmetry that caused the bug: `exports` targets *must* be "./"-prefixed
     * relative specifiers, while `bin` targets must *not* be. Getting them the same
     * way round is the natural mistake.
     */
    it("has bin paths without a leading ./", () => {
        for (const [name, target] of Object.entries(manifest.bin)) {
            expect(target.startsWith("./"), `bin[${name}] = ${target}`).toBe(
                false,
            )
            expect(target.startsWith("dist/"), `bin[${name}] = ${target}`).toBe(
                true,
            )
        }
    })

    it("has exports targets with a leading ./", () => {
        const targets: string[] = []
        const walk = (value: unknown): void => {
            if (typeof value === "string") targets.push(value)
            else if (value && typeof value === "object") {
                Object.values(value).forEach(walk)
            }
        }
        walk(manifest.exports)
        for (const target of targets) {
            expect(target.startsWith("./"), target).toBe(true)
        }
    })

    it("ships only what it means to", () => {
        expect(manifest.files).toEqual(["dist"])
        // LICENSE, README and package.json are always included regardless of `files`.
        expect(manifest.license).toBe("MIT")
    })

    it("declares no runtime dependencies", () => {
        // The analyzer is hand-rolled precisely so this stays empty; a dependency here
        // would be a deliberate decision, not an accident.
        //
        // Absent and empty both mean "none". `npm pkg set` strips an empty
        // `dependencies` object when it rewrites the manifest, which the CI matrix
        // does on every run to pin the TypeORM version — so asserting the key exists
        // tested the shape of npm's normalizer rather than anything about this package.
        expect(runtimeDependencies()).toEqual({})
    })

    it("keeps typeorm a peer dependency spanning both supported majors", () => {
        expect(manifest.peerDependencies.typeorm).toBe("^0.3.0 || ^1.0.0-dev")
        expect(runtimeDependencies()).not.toHaveProperty("typeorm")
    })

    it("points main and types at the CJS build", () => {
        expect(manifest.main).toBe("./dist/cjs/index.js")
        expect(manifest.types).toBe("./dist/cjs/index.d.ts")
    })

    it("has the publish metadata npm and provenance need", () => {
        expect(manifest.repository.url).toMatch(/^git\+https:\/\/github\.com\//)
        expect(manifest.name).toBe("typeorm-strong-migrations")
        expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/)
    })
})
