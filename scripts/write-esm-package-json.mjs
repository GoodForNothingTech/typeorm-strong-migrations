// dist/esm holds .mjs files, which Node always treats as ESM. The marker package.json
// is belt-and-braces for bundlers that resolve by directory rather than extension.
import { writeFileSync, existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"

const dir = resolve(process.cwd(), "dist/esm")
if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
writeFileSync(
    resolve(dir, "package.json"),
    JSON.stringify({ type: "module" }, null, 2) + "\n",
)

const cjs = resolve(process.cwd(), "dist/cjs")
if (!existsSync(cjs)) mkdirSync(cjs, { recursive: true })
writeFileSync(
    resolve(cjs, "package.json"),
    JSON.stringify({ type: "commonjs" }, null, 2) + "\n",
)

// stderr, not stdout: these scripts run under `prepack`, so `npm pack` executes them
// while a caller is capturing its stdout to learn the tarball filename. Anything
// printed here lands in that capture and corrupts the name.
console.error(
    "write-esm-package-json: wrote dist/esm/package.json and dist/cjs/package.json",
)
