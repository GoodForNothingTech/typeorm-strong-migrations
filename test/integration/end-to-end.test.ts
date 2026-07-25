import type { DataSource } from "typeorm"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { UnsafeMigrationError } from "../../src/errors"
import { installStrongMigrations } from "../../src/install/install"
import { defineMigration } from "../../src/testing"
import {
    createDataSource,
    isPostgres,
    quote,
    resetSchema,
} from "../helpers/data-source"

/**
 * Everything that genuinely needs a database: real migrations through TypeORM's own
 * MigrationExecutor, real transaction modes, real timeouts. The bulk of the suite
 * is unit-level, because which check fires and what it says needs no server.
 */
describe("end to end", () => {
    let dataSource: DataSource | undefined

    beforeEach(async () => {
        dataSource = undefined
    })

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy()
    })

    async function boot(
        migrations: Parameters<typeof createDataSource>[0],
        overrides: Record<string, unknown> = {},
        config: Record<string, unknown> = {},
    ): Promise<DataSource> {
        const created = await createDataSource(migrations, overrides as never)
        dataSource = installStrongMigrations(created, config as never)
        await dataSource.initialize()
        await resetSchema(dataSource)
        return dataSource
    }

    it("rejects a non-concurrent index during a real migration run", async () => {
        if (!isPostgres) return
        const Migration = defineMigration("AddIndex", {
            async up(queryRunner) {
                await queryRunner.query(
                    `CREATE INDEX "IDX_users_email" ON "users" ("email")`,
                )
            },
        })
        const ds = await boot([Migration], {
            migrationsTransactionMode: "each",
        })

        await expect(ds.runMigrations()).rejects.toThrow(UnsafeMigrationError)

        // The failed migration must not be recorded, so it can be fixed and rerun.
        const runner = ds.createQueryRunner()
        try {
            const rows = await runner
                .query(`SELECT * FROM "migrations"`)
                .catch(() => [])
            expect(rows).toHaveLength(0)
        } finally {
            await runner.release()
        }
    })

    it("runs a concurrent index cleanly with transaction = false", async () => {
        if (!isPostgres) return
        const Migration = defineMigration("AddIndexConcurrently", {
            transaction: false,
            async up(queryRunner) {
                await queryRunner.query(
                    `CREATE INDEX CONCURRENTLY "IDX_users_email" ON "users" ("email")`,
                )
            },
            async down(queryRunner) {
                await queryRunner.query(
                    `DROP INDEX CONCURRENTLY "IDX_users_email"`,
                )
            },
        })
        const ds = await boot([Migration], {
            migrationsTransactionMode: "each",
        })

        await expect(ds.runMigrations()).resolves.toHaveLength(1)

        const runner = ds.createQueryRunner()
        try {
            const rows = await runner.query(
                `SELECT indexname FROM pg_indexes WHERE indexname = 'IDX_users_email'`,
            )
            expect(rows).toHaveLength(1)
        } finally {
            await runner.release()
        }
    })

    /**
     * The advice in our own messages, executed verbatim. If TypeORM's rejection of
     * `transaction` overrides under "all" ever changes, this is what notices.
     */
    it("explains the mode conflict when transaction = false meets the default mode", async () => {
        const Migration = defineMigration("NeedsNoTransaction", {
            transaction: false,
            async up(queryRunner) {
                await queryRunner.query(`SELECT 1`)
            },
        })
        const ds = await boot([Migration], { migrationsTransactionMode: "all" })

        await expect(ds.runMigrations()).rejects.toThrow(
            /migrationsTransactionMode: "each"/,
        )
    })

    it("allows a safe migration through untouched", async () => {
        const Migration = defineMigration("CreateThing", {
            async up(queryRunner) {
                await queryRunner.query(
                    isPostgres
                        ? `CREATE TABLE "things" ("id" SERIAL PRIMARY KEY)`
                        : "CREATE TABLE `things` (`id` int NOT NULL AUTO_INCREMENT PRIMARY KEY)",
                )
            },
            async down(queryRunner) {
                await queryRunner.query(`DROP TABLE ${quote("things")}`)
            },
        })
        const ds = await boot([Migration])

        await expect(ds.runMigrations()).resolves.toHaveLength(1)
        await ds.undoLastMigration()
    })

    it("lets safetyAssured through end to end", async () => {
        const { safetyAssured } =
            await import("../../src/runtime/safety-assured")
        const Migration = defineMigration("DropColumn", {
            async up(queryRunner) {
                await safetyAssured(async () => {
                    await queryRunner.query(
                        `ALTER TABLE ${quote("users")} DROP COLUMN ${quote("name")}`,
                    )
                })
            },
        })
        const ds = await boot([Migration])
        await expect(ds.runMigrations()).resolves.toHaveLength(1)
    })

    it("rejects the same drop without safetyAssured", async () => {
        const Migration = defineMigration("DropColumnUnsafe", {
            async up(queryRunner) {
                await queryRunner.query(
                    `ALTER TABLE ${quote("users")} DROP COLUMN ${quote("name")}`,
                )
            },
        })
        const ds = await boot([Migration])
        await expect(ds.runMigrations()).rejects.toThrow(UnsafeMigrationError)
    })

    it("grandfathers migrations at or below startAfter", async () => {
        const Migration = defineMigration("OldUnsafe", {
            timestamp: 1_600_000_000_000,
            async up(queryRunner) {
                await queryRunner.query(
                    `ALTER TABLE ${quote("users")} DROP COLUMN ${quote("name")}`,
                )
            },
        })
        const ds = await boot(
            [Migration],
            {},
            { startAfter: 1_700_000_000_000 },
        )
        await expect(ds.runMigrations()).resolves.toHaveLength(1)
    })

    it("never flags TypeORM's own migrations-table bookkeeping", async () => {
        // The very first run creates and writes to the migrations table; if that were
        // checked, no project could ever get started.
        const Migration = defineMigration("Noop", {
            async up(queryRunner) {
                await queryRunner.query(`SELECT 1`)
            },
        })
        const ds = await boot([Migration])
        await expect(ds.runMigrations()).resolves.toHaveLength(1)
    })
})

describe("session setup", () => {
    let dataSource: DataSource | undefined

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy()
    })

    it("applies the configured lock and statement timeouts to the session", async () => {
        if (!isPostgres) return
        let observed: { lock: string; statement: string } | undefined

        const Migration = defineMigration("ReadTimeouts", {
            async up(queryRunner) {
                const lock = await queryRunner.query("SHOW lock_timeout")
                const statement = await queryRunner.query(
                    "SHOW statement_timeout",
                )
                observed = {
                    lock: String(lock[0].lock_timeout),
                    statement: String(statement[0].statement_timeout),
                }
            },
        })

        const created = await createDataSource([Migration], {
            migrationsTransactionMode: "each",
        } as never)
        dataSource = installStrongMigrations(created, {
            lockTimeout: "10s",
            statementTimeout: "1h",
        })
        await dataSource.initialize()
        await resetSchema(dataSource)
        await dataSource.runMigrations()

        expect(observed?.lock).toBe("10s")
        expect(observed?.statement).toBe("1h")
    })
})
