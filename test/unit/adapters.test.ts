import { describe, expect, it } from "vitest"
import {
    createAdapter,
    reconcileMariaDb,
    versionWarning,
} from "../../src/adapters/factory"
import { baseConfig, mergeConfig } from "../../src/config"
import { analyzeSql } from "../../src/sql/analyze"
import { createFakeRunner } from "../helpers/fake-query-runner"

describe("targetSqlMode", () => {
    /**
     * The option was declared, validated, merged, defaulted and documented — and then
     * never reached the adapter, so setting it did nothing at all.
     */
    it("reaches the adapter in development", () => {
        const { queryRunner } = createFakeRunner({ dialect: "mysql" })
        const config = mergeConfig(baseConfig(), {
            env: "development",
            targetSqlMode: "ANSI_QUOTES,STRICT_TRANS_TABLES",
        })
        const adapter = createAdapter("mysql", queryRunner, config)
        expect(adapter.lexerOptions().ansiQuotes).toBe(true)
    })

    /** Production must read the mode from the server it is actually talking to. */
    it("is ignored outside development, like targetVersion", () => {
        const { queryRunner } = createFakeRunner({ dialect: "mysql" })
        const config = mergeConfig(baseConfig(), {
            env: "production",
            targetSqlMode: "ANSI_QUOTES",
        })
        const adapter = createAdapter("mysql", queryRunner, config)
        expect(adapter.lexerOptions().ansiQuotes).toBe(false)
    })

    /** `ANSI` is a composite mode that implies ANSI_QUOTES. */
    it("recognizes the composite ANSI mode", () => {
        const { queryRunner } = createFakeRunner({ dialect: "mysql" })
        const config = mergeConfig(baseConfig(), {
            env: "test",
            targetSqlMode: "REAL_AS_FLOAT,ANSI,PIPES_AS_CONCAT",
        })
        expect(
            createAdapter("mysql", queryRunner, config).lexerOptions()
                .ansiQuotes,
        ).toBe(true)
    })

    it("detects NO_BACKSLASH_ESCAPES", () => {
        const { queryRunner } = createFakeRunner({ dialect: "mysql" })
        const config = mergeConfig(baseConfig(), {
            env: "test",
            targetSqlMode: "NO_BACKSLASH_ESCAPES",
        })
        expect(
            createAdapter("mysql", queryRunner, config).lexerOptions()
                .noBackslashEscapes,
        ).toBe(true)
    })

    /**
     * Under ANSI_QUOTES a double-quoted word is an identifier rather than a string,
     * so lexing with the wrong assumption reads a bogus table name.
     */
    it("changes how the lexer reads a double-quoted identifier", () => {
        const withoutAnsi = analyzeSql(
            `ALTER TABLE "users" ADD "c" int`,
            "mysql",
        )
        const withAnsi = analyzeSql(
            `ALTER TABLE "users" ADD "c" int`,
            "mysql",
            {
                ansiQuotes: true,
            },
        )
        expect(
            (withAnsi[0] as never as { table: { name: string } }).table.name,
        ).toBe("users")
        expect(withoutAnsi[0]?.kind).not.toBe("addColumn")
    })

    it("leaves Postgres alone, which has no such knobs", () => {
        const { queryRunner } = createFakeRunner({ dialect: "postgres" })
        expect(createAdapter("postgres", queryRunner).lexerOptions()).toEqual({
            ansiQuotes: false,
            noBackslashEscapes: false,
        })
    })
})

describe("minimum server versions", () => {
    /**
     * The enforcement function existed but nothing called it, so a Postgres 9.6 server
     * ran with silently weaker checks and no signal. It now warns rather than raising:
     * failing a whole migration run over a server version is worse than the problem.
     */
    it("warns below the minimum", () => {
        const { queryRunner } = createFakeRunner({ dialect: "postgres" })
        const adapter = createAdapter("postgres", queryRunner)
        adapter.setVersion("9.6")
        expect(versionWarning(adapter)).toMatch(/older than the minimum/)
    })

    it("stays quiet at or above the minimum", () => {
        const { queryRunner } = createFakeRunner({ dialect: "postgres" })
        const adapter = createAdapter("postgres", queryRunner)
        adapter.setVersion("16.2")
        expect(versionWarning(adapter)).toBeUndefined()
    })

    it("stays quiet when the version is unknown", () => {
        const { queryRunner } = createFakeRunner({ dialect: "postgres" })
        const adapter = createAdapter("postgres", queryRunner)
        adapter.setVersion(undefined)
        expect(versionWarning(adapter)).toBeUndefined()
    })

    it("uses the MariaDB floor once the adapter is reconciled", () => {
        const { queryRunner } = createFakeRunner({ dialect: "mysql" })
        const adapter = reconcileMariaDb(
            createAdapter("mysql", queryRunner),
            "10.3.0-MariaDB",
            queryRunner,
        )
        // 10.3 is below MariaDB's 10.5 floor but above MySQL's 8.0 — so this only
        // warns if the reconcile actually took effect.
        expect(adapter.minVersion).toBe("10.5")
        expect(versionWarning(adapter)).toMatch(/older than the minimum/)
    })
})
