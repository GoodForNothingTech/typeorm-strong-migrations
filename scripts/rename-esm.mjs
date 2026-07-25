// Turns tsc's ESM output into real .mjs/.d.mts files with explicit relative
// specifiers. tsc is run with moduleResolution "bundler" so the source can use
// extensionless imports; this script resolves each specifier against the emitted
// tree and appends the right extension.
import {
    existsSync,
    readdirSync,
    renameSync,
    readFileSync,
    writeFileSync,
    statSync,
} from "node:fs"
import { join, dirname, resolve } from "node:path"

const ROOT = resolve(process.cwd(), "dist/esm")

function walk(dir) {
    const out = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) out.push(...walk(full))
        else out.push(full)
    }
    return out
}

if (!existsSync(ROOT)) {
    console.error(
        `rename-esm: ${ROOT} does not exist — run the ESM build first`,
    )
    process.exit(1)
}

// 1. Rename .js -> .mjs and .d.ts -> .d.mts (declaration maps follow their file).
const renames = new Map()
for (const file of walk(ROOT)) {
    let target = null
    if (file.endsWith(".d.ts"))
        target = file.slice(0, -".d.ts".length) + ".d.mts"
    else if (file.endsWith(".d.ts.map"))
        target = file.slice(0, -".d.ts.map".length) + ".d.mts.map"
    else if (file.endsWith(".js"))
        target = file.slice(0, -".js".length) + ".mjs"
    else if (file.endsWith(".js.map"))
        target = file.slice(0, -".js.map".length) + ".mjs.map"
    if (target) {
        renameSync(file, target)
        renames.set(file, target)
    }
}

// 2. Rewrite relative specifiers. A specifier may point at a file or a directory
//    (barrel), so probe both before deciding what to append.
const SPECIFIER =
    /(\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)(["'])(\.{1,2}\/[^"']*)\2/gm

function resolveSpecifier(fromFile, specifier, ext) {
    const base = resolve(dirname(fromFile), specifier)
    if (existsSync(base + ext)) return specifier + ext
    if (
        existsSync(base) &&
        statSync(base).isDirectory() &&
        existsSync(join(base, "index" + ext))
    ) {
        return specifier.replace(/\/$/, "") + "/index" + ext
    }
    return null
}

for (const file of walk(ROOT)) {
    const isDecl = file.endsWith(".d.mts")
    if (!isDecl && !file.endsWith(".mjs")) continue
    const ext = isDecl ? ".d.mts" : ".mjs"
    const source = readFileSync(file, "utf8")
    let changed = false
    const next = source.replace(SPECIFIER, (match, head, quote, specifier) => {
        if (/\.(mjs|d\.mts|json)$/.test(specifier)) return match
        const resolved = resolveSpecifier(file, specifier, ext)
        if (!resolved) return match
        changed = true
        return `${head}${quote}${resolved}${quote}`
    })
    if (changed) writeFileSync(file, next)
}

// 3. Point sourceMappingURL comments at the renamed maps.
for (const file of walk(ROOT)) {
    if (!file.endsWith(".mjs") && !file.endsWith(".d.mts")) continue
    const source = readFileSync(file, "utf8")
    const next = source
        .replace(
            /sourceMappingURL=(.+?)\.js\.map/g,
            "sourceMappingURL=$1.mjs.map",
        )
        .replace(
            /sourceMappingURL=(.+?)\.d\.ts\.map/g,
            "sourceMappingURL=$1.d.mts.map",
        )
    if (next !== source) writeFileSync(file, next)
}

console.log(`rename-esm: renamed ${renames.size} files under dist/esm`)
