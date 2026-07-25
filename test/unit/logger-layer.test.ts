import type { DataSource, Logger } from "typeorm"
import { describe, expect, it, vi } from "vitest"
import {
    installLoggerLayer,
    uninstallLoggerLayer,
} from "../../src/install/logger-layer"
import { createFakeRunner } from "../helpers/fake-query-runner"

/**
 * The logger layer is the backstop for SQL that reaches the database without passing
 * through the wrapped QueryRunner. It had no tests, despite being the trickiest code
 * in the package — its own comments record past bugs where "the unsafe statement ran
 * unreported".
 */

function fakeDataSource(logger?: Logger): DataSource {
    const { dataSource } = createFakeRunner()
    ;(dataSource as { logger?: Logger }).logger = logger
    return dataSource
}

function recordingLogger(): Logger & { queries: string[] } {
    const queries: string[] = []
    const noop = (): void => {}
    return {
        queries,
        logQuery: (query: string) => queries.push(query),
        logQueryError: noop,
        logQuerySlow: noop,
        logSchemaBuild: noop,
        logMigration: noop,
        log: noop,
    } as Logger & { queries: string[] }
}

describe("logger layer installation", () => {
    /**
     * `MigrationRunCommand` calls `setOptions({ logging: [...] })`, which rebuilds
     * `dataSource.logger` from `options.logger ?? this.options.logger`. A wrapper set
     * only on the instance field is discarded the moment the CLI starts.
     */
    it("installs on both the instance and the options", () => {
        const dataSource = fakeDataSource()
        installLoggerLayer(dataSource)
        expect((dataSource.options as { logger?: unknown }).logger).toBe(
            dataSource.logger,
        )
    })

    it("is idempotent", () => {
        const dataSource = fakeDataSource()
        installLoggerLayer(dataSource)
        const first = dataSource.logger
        installLoggerLayer(dataSource)
        expect(dataSource.logger).toBe(first)
    })

    it("restores the previous logger on uninstall", () => {
        const original = recordingLogger()
        const dataSource = fakeDataSource(original)
        installLoggerLayer(dataSource)
        expect(dataSource.logger).not.toBe(original)
        uninstallLoggerLayer(dataSource)
        expect(dataSource.logger).toBe(original)
        expect(
            (dataSource.options as { logger?: unknown }).logger,
        ).toBeUndefined()
    })

    it("does nothing on uninstall when it was never installed", () => {
        const dataSource = fakeDataSource()
        expect(() => uninstallLoggerLayer(dataSource)).not.toThrow()
    })
})

describe("delegation", () => {
    /**
     * Built lazily on purpose: resolving the inner logger at install time would
     * capture the pre-CLI logging config and silently drop the query logging the user
     * asked for.
     */
    it("passes queries through to the wrapped logger", () => {
        const inner = recordingLogger()
        const dataSource = fakeDataSource(inner)
        installLoggerLayer(dataSource)

        dataSource.logger.logQuery("SELECT 1")
        expect(inner.queries).toEqual(["SELECT 1"])
    })

    it("forwards every other Logger method", () => {
        const inner = recordingLogger()
        const schema = vi.fn()
        const migration = vi.fn()
        const log = vi.fn()
        Object.assign(inner, {
            logSchemaBuild: schema,
            logMigration: migration,
            log,
        })

        const dataSource = fakeDataSource(inner)
        installLoggerLayer(dataSource)

        dataSource.logger.logSchemaBuild("building")
        dataSource.logger.logMigration("migrating")
        dataSource.logger.log("warn", "careful")

        expect(schema).toHaveBeenCalledWith("building", undefined)
        expect(migration).toHaveBeenCalledWith("migrating", undefined)
        expect(log).toHaveBeenCalledWith("warn", "careful", undefined)
    })

    it("survives having no previous logger at all", () => {
        const dataSource = fakeDataSource()
        installLoggerLayer(dataSource)
        expect(() => dataSource.logger.logQuery("SELECT 1")).not.toThrow()
    })
})

describe("inspection", () => {
    /**
     * Outside a migration there is no checker, so application traffic must pass
     * untouched — this layer sees every query the process makes, including while a
     * server is booting with `migrationsRun: true`.
     */
    it("ignores queries with no active migration", () => {
        const inner = recordingLogger()
        const dataSource = fakeDataSource(inner)
        installLoggerLayer(dataSource)

        expect(() =>
            dataSource.logger.logQuery(
                `ALTER TABLE "users" DROP COLUMN "email"`,
            ),
        ).not.toThrow()
        expect(inner.queries).toHaveLength(1)
    })
})
