/**
 * Every runtime touch of `typeorm` goes through this file.
 *
 * Importing these symbols statically would break in two directions: a type error
 * for consumers on a TypeORM major where the symbol was removed, and a hard crash
 * inside our own code when the value resolves to `undefined`. Resolving lazily
 * keeps one build working across TypeORM 0.3.x and 1.x.
 *
 * Types are imported normally elsewhere — they erase completely.
 */

import { createRequire } from "node:module"

type Ctor = new (...args: any[]) => any

let cached: Record<string, unknown> | undefined
let resolveFailed = false

/**
 * The same source compiles to both CJS and ESM, and `require` exists in only one of
 * them. A bare call in the `.mjs` build throws `ReferenceError: require is not
 * defined`, which the catch below turned into a permanent `resolveFailed` — so every
 * ESM consumer silently lost feature detection and fell back to the 0.3.x code paths.
 * `typeof` on an undeclared identifier is safe, and `createRequire` covers ESM:
 * typeorm is a peer dependency, so it resolves from the consumer's tree.
 */
function loadTypeorm(): Record<string, unknown> {
    if (typeof require === "function")
        return require("typeorm") as Record<string, unknown>
    return createRequire(`${process.cwd()}/`)("typeorm") as Record<
        string,
        unknown
    >
}

function typeorm(): Record<string, unknown> | undefined {
    if (cached || resolveFailed) return cached
    try {
        cached = loadTypeorm()
    } catch {
        resolveFailed = true
    }
    return cached
}

function exported<T = unknown>(name: string): T | undefined {
    return typeorm()?.[name] as T | undefined
}

/**
 * `new TableIndex(...)`. `isConcurrent` only exists on TypeORM >= 1.0, which is
 * why safeByDefault index rewrites feature-detect before using it.
 */
export function TableIndexCtor(): Ctor | undefined {
    return exported<Ctor>("TableIndex")
}

/**
 * True when the installed TypeORM emits `CREATE INDEX CONCURRENTLY` from
 * `TableIndex.isConcurrent`. On 0.3.x the field does not exist and the safe form
 * has to be written as raw SQL.
 */
export function supportsConcurrentTableIndex(): boolean {
    const ctor = TableIndexCtor()
    if (!ctor) return false
    try {
        return "isConcurrent" in new ctor({ columnNames: [] })
    } catch {
        return false
    }
}

/**
 * TypeORM tags its metadata classes with a `Symbol.for(...)` brand so identity
 * survives duplicate installs in node_modules. Prefer the library's own checker,
 * and fall back to reading the brand ourselves when it is unavailable.
 */
interface InstanceCheckerShape {
    isTable(x: unknown): boolean
    isTableColumn(x: unknown): boolean
    isTableIndex(x: unknown): boolean
    isTableForeignKey(x: unknown): boolean
    isTableUnique(x: unknown): boolean
    isTableCheck(x: unknown): boolean
    isTableExclusion(x: unknown): boolean
}

function brandedAs(value: unknown, brand: string): boolean {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as Record<string, unknown>)["@instanceof"] === Symbol.for(brand)
    )
}

function checker(): Partial<InstanceCheckerShape> {
    return exported<Partial<InstanceCheckerShape>>("InstanceChecker") ?? {}
}

export const is = {
    table: (x: unknown): boolean =>
        checker().isTable?.(x) ?? brandedAs(x, "Table"),
    tableColumn: (x: unknown): boolean =>
        checker().isTableColumn?.(x) ?? brandedAs(x, "TableColumn"),
    tableIndex: (x: unknown): boolean =>
        checker().isTableIndex?.(x) ?? brandedAs(x, "TableIndex"),
    tableForeignKey: (x: unknown): boolean =>
        checker().isTableForeignKey?.(x) ?? brandedAs(x, "TableForeignKey"),
    tableUnique: (x: unknown): boolean =>
        checker().isTableUnique?.(x) ?? brandedAs(x, "TableUnique"),
    tableCheck: (x: unknown): boolean =>
        checker().isTableCheck?.(x) ?? brandedAs(x, "TableCheck"),
    tableExclusion: (x: unknown): boolean =>
        checker().isTableExclusion?.(x) ?? brandedAs(x, "TableExclusion"),
}
