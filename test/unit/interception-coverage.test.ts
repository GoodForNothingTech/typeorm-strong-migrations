import { readFileSync } from "node:fs"
import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { INTERCEPTED_METHODS } from "../../src/operations/from-typed"

/**
 * The guard rail.
 *
 * Sixteen schema-mutating QueryRunner methods once reached none of the three
 * interception paths — including `clearDatabase`, which drops every table. Nothing
 * detected that, because a method absent from `INTERCEPTED_METHODS` simply passes
 * through: no error, no warning, no operation.
 *
 * This test reads TypeORM's own `QueryRunner` interface and requires every
 * schema-mutating method to be either intercepted or on the explicit allowlist below.
 * When TypeORM adds a method, this fails rather than the gap silently reopening.
 */

const QUERY_RUNNER = resolve(
    process.cwd(),
    "typeorm/src/query-runner/QueryRunner.ts",
)

/**
 * Methods that mutate nothing, or whose mutation we deliberately do not model.
 * Every entry needs a reason — an unexplained entry here is how coverage rots.
 */
const NOT_INTERCEPTED: Record<string, string> = {
    // Read-only introspection.
    connect: "session lifecycle",
    release: "session lifecycle",
    beforeMigration: "session lifecycle",
    afterMigration: "session lifecycle",
    startTransaction: "transaction control, checked via isTransactionActive",
    commitTransaction: "transaction control",
    rollbackTransaction: "transaction control",
    getDatabases: "read-only",
    getSchemas: "read-only",
    getTable: "read-only",
    getTables: "read-only",
    getView: "read-only",
    getViews: "read-only",
    getReplicationMode: "read-only",
    hasDatabase: "read-only",
    getCurrentDatabase: "read-only",
    hasSchema: "read-only",
    getCurrentSchema: "read-only",
    hasTable: "read-only",
    hasColumn: "read-only",
    stream: "read-only; returns a cursor over a SELECT",
    // SQL-memory mode buffers statements rather than executing them. The buffered
    // SQL is replayed through query(), which is intercepted.
    enableSqlMemory: "buffering toggle",
    disableSqlMemory: "buffering toggle",
    clearSqlMemory: "buffering toggle",
    getMemorySql: "read-only",
    executeMemoryUpSql:
        "replays buffered SQL through query(), which is intercepted",
    executeMemoryDownSql:
        "replays buffered SQL through query(), which is intercepted",
}

function mutatingMethods(source: string): string[] {
    const found = new Set<string>()
    // Interface members look like `name(args): Promise<...>` at one indent level.
    const pattern = /^\s{4}(\w+)(?:<[^>]*>)?\(/gm
    for (const match of source.matchAll(pattern)) {
        found.add(match[1]!)
    }
    return [...found].sort()
}

describe("QueryRunner interception coverage", () => {
    const available = existsSync(QUERY_RUNNER)

    it.skipIf(!available)(
        "intercepts every schema-mutating QueryRunner method",
        () => {
            const methods = mutatingMethods(readFileSync(QUERY_RUNNER, "utf8"))
            expect(methods.length).toBeGreaterThan(30)

            const uncovered = methods.filter(
                (method) =>
                    !INTERCEPTED_METHODS.has(method) &&
                    !(method in NOT_INTERCEPTED),
            )

            expect(
                uncovered,
                `These QueryRunner methods reach no interception path. Add each to\n` +
                    `INTERCEPTED_METHODS with a case in from-typed.ts, or to the\n` +
                    `NOT_INTERCEPTED allowlist with a reason:\n  ${uncovered.join("\n  ")}`,
            ).toEqual([])
        },
    )

    it.skipIf(!available)("has no stale allowlist entries", () => {
        const methods = new Set(
            mutatingMethods(readFileSync(QUERY_RUNNER, "utf8")),
        )
        const stale = Object.keys(NOT_INTERCEPTED).filter(
            (method) => !methods.has(method),
        )
        expect(
            stale,
            `Allowlisted methods that no longer exist: ${stale.join(", ")}`,
        ).toEqual([])
    })

    it("covers the destructive methods that were previously invisible", () => {
        // Named explicitly so a refactor cannot quietly drop them again.
        for (const method of [
            "clearDatabase",
            "dropSchema",
            "dropDatabase",
            "dropView",
            "dropPrimaryKey",
            "updatePrimaryKeys",
            "dropUniqueConstraints",
            "dropCheckConstraints",
            "dropExclusionConstraints",
        ]) {
            expect(INTERCEPTED_METHODS.has(method), method).toBe(true)
        }
    })
})
