import type { DataSource, MigrationInterface } from "typeorm"
import { describe, expect, it, vi } from "vitest"
import {
    installStrongMigrations,
    isInstalled,
    uninstallStrongMigrations,
} from "../../src/install/install"
import { UnsafeMigrationError } from "../../src/errors"
import { state } from "../../src/state"
import { createFakeRunner } from "../helpers/fake-query-runner"

/**
 * Covers the patching itself. Three methods are patched rather than one because
 * `migrationsRun: true` runs migrations *inside* `initialize()`, so wrapping only
 * after initialize resolves would be too late for that path — which is exactly what
 * NestJS `forRoot({ migrationsRun: true })` does.
 */

function fakeDataSource(
    migrations: MigrationInterface[],
    options: {
        migrationsTransactionMode?: "all" | "each" | "none"
        type?: string
    } = {},
): DataSource {
    const { queryRunner } = createFakeRunner()
    const dataSource = {
        options: {
            type: options.type ?? "postgres",
            database: "test",
            migrationsTransactionMode: options.migrationsTransactionMode,
        },
        driver: { version: "16.2" },
        entityMetadatas: [],
        migrations,
        isInitialized: false,
        logger: undefined,
        createQueryRunner: () => queryRunner,
        initialize: vi.fn(async function (this: DataSource) {
            ;(this as { isInitialized: boolean }).isInitialized = true
            return this
        }),
        runMigrations: vi.fn(async () => []),
        undoLastMigration: vi.fn(async () => {}),
    } as unknown as DataSource
    return dataSource
}

function migration(name: string, transaction?: boolean): MigrationInterface {
    return {
        name,
        transaction,
        async up() {},
        async down() {},
    }
}

describe("installStrongMigrations", () => {
    it("returns the same instance so it composes around a constructor", () => {
        const dataSource = fakeDataSource([])
        expect(installStrongMigrations(dataSource)).toBe(dataSource)
        expect(isInstalled(dataSource)).toBe(true)
    })

    it("is idempotent, and a second call updates config rather than double-patching", async () => {
        const dataSource = fakeDataSource([])
        installStrongMigrations(dataSource, { startAfter: 1 })
        const patched = dataSource.initialize
        installStrongMigrations(dataSource, { startAfter: 2 })
        expect(dataSource.initialize).toBe(patched)
        expect(state().installs.get(dataSource)?.config.startAfter).toBe(2)
    })

    it("keeps per-DataSource config isolated", () => {
        const first = fakeDataSource([])
        const second = fakeDataSource([])
        installStrongMigrations(first, { startAfter: 111 })
        installStrongMigrations(second, { startAfter: 222 })
        expect(state().installs.get(first)?.config.startAfter).toBe(111)
        expect(state().installs.get(second)?.config.startAfter).toBe(222)
    })

    it("wraps migrations when initialize resolves", async () => {
        const target = migration("AddIndex1700000000000")
        const original = target.up
        const dataSource = fakeDataSource([target])
        installStrongMigrations(dataSource)
        await dataSource.initialize()
        expect(target.up).not.toBe(original)
    })

    it("wraps migrations again at runMigrations, since buildMetadatas reassigns the array", async () => {
        const dataSource = fakeDataSource([])
        installStrongMigrations(dataSource)
        await dataSource.initialize()

        // Stand in for buildMetadatas replacing the array after initialize.
        const late = migration("Late1700000000000")
        const originalUp = late.up
        ;(dataSource as { migrations: MigrationInterface[] }).migrations = [
            late,
        ]

        await dataSource.runMigrations()
        expect(late.up).not.toBe(originalUp)
    })

    it("records the effective transaction mode from runMigrations", async () => {
        const dataSource = fakeDataSource([], {
            migrationsTransactionMode: "all",
        })
        installStrongMigrations(dataSource)
        await dataSource.initialize()
        await dataSource.runMigrations({ transaction: "each" })
        const record = state().installs.get(dataSource)
        expect(record?.transactionMode).toBe("each")
        expect(record?.transactionModeInferred).toBe(false)
    })

    it("restores the original methods on uninstall", async () => {
        const dataSource = fakeDataSource([])
        const originalRun = dataSource.runMigrations
        installStrongMigrations(dataSource)
        expect(dataSource.runMigrations).not.toBe(originalRun)
        uninstallStrongMigrations(dataSource)
        expect(dataSource.runMigrations).toBe(originalRun)
        expect(isInstalled(dataSource)).toBe(false)
    })

    it("installs the logger on options too, so the CLI's setOptions cannot drop it", () => {
        const dataSource = fakeDataSource([])
        installStrongMigrations(dataSource)
        // MigrationRunCommand calls setOptions({ logging: [...] }), which rebuilds
        // dataSource.logger from `options.logger ?? this.options.logger`.
        expect((dataSource.options as { logger?: unknown }).logger).toBe(
            dataSource.logger,
        )
    })
})

describe("transactionMode preflight", () => {
    /**
     * TypeORM rejects any migration that sets `transaction` — including `true` —
     * while the mode is "all", and its own error explains none of that. Since our
     * own advice tells people to set `transaction = false`, catching it first is the
     * difference between a fix and a dead end.
     */
    it("explains the conflict before TypeORM raises its opaque error", async () => {
        const dataSource = fakeDataSource(
            [migration("AddIndex1700000000000", false)],
            {
                migrationsTransactionMode: "all",
            },
        )
        installStrongMigrations(dataSource)
        await dataSource.initialize()

        await expect(dataSource.runMigrations()).rejects.toThrow(
            UnsafeMigrationError,
        )
        await expect(dataSource.runMigrations()).rejects.toThrow(
            /migrationsTransactionMode: "each"/,
        )
    })

    it("also fires for transaction = true, which TypeORM rejects just the same", async () => {
        const dataSource = fakeDataSource(
            [migration("AddIndex1700000000000", true)],
            {
                migrationsTransactionMode: "all",
            },
        )
        installStrongMigrations(dataSource)
        await dataSource.initialize()
        await expect(dataSource.runMigrations()).rejects.toThrow(
            UnsafeMigrationError,
        )
    })

    it("stays quiet when the mode already permits the override", async () => {
        const dataSource = fakeDataSource(
            [migration("AddIndex1700000000000", false)],
            {
                migrationsTransactionMode: "each",
            },
        )
        installStrongMigrations(dataSource)
        await dataSource.initialize()
        await expect(dataSource.runMigrations()).resolves.toEqual([])
    })

    it("stays quiet when no migration overrides the mode", async () => {
        const dataSource = fakeDataSource(
            [migration("AddIndex1700000000000")],
            {
                migrationsTransactionMode: "all",
            },
        )
        installStrongMigrations(dataSource)
        await dataSource.initialize()
        await expect(dataSource.runMigrations()).resolves.toEqual([])
    })

    it("can be disabled like any other check", async () => {
        const dataSource = fakeDataSource(
            [migration("AddIndex1700000000000", false)],
            {
                migrationsTransactionMode: "all",
            },
        )
        installStrongMigrations(dataSource, {
            enabledChecks: { transactionMode: false },
        })
        await dataSource.initialize()
        await expect(dataSource.runMigrations()).resolves.toEqual([])
    })
})

describe("unsupported drivers", () => {
    it("warns once and runs the migration unchecked", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            const target = migration("DropColumn1700000000000")
            const dataSource = fakeDataSource([target], {
                type: "better-sqlite3",
            })
            installStrongMigrations(dataSource)
            await dataSource.initialize()

            const { queryRunner } = createFakeRunner({ dialect: "postgres" })
            // An operation that would normally be rejected outright.
            target.up = async (qr) => {
                await qr.query('ALTER TABLE "users" DROP COLUMN "email"')
            }
            await expect(
                (dataSource.migrations[0] as MigrationInterface).up(
                    queryRunner,
                ),
            ).resolves.toBeUndefined()
        } finally {
            warn.mockRestore()
        }
    })
})
