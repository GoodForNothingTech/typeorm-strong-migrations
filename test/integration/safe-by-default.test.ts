import type { DataSource } from "typeorm"
import { afterEach, describe, expect, it } from "vitest"
import { installStrongMigrations } from "../../src/install/install"
import { defineMigration } from "../../src/testing"
import {
    createDataSource,
    isPostgres,
    resetSchema,
} from "../helpers/data-source"

/**
 * The riskiest part of safeByDefault is not the rewrite itself but the transaction
 * juggling around it: CONCURRENTLY cannot run inside a transaction, so the rewrite
 * commits the one TypeORM opened and a transaction is re-opened afterwards so
 * TypeORM's own commit does not fail with TransactionNotStartedError. That only
 * really proves out against a live server.
 */
describe("safeByDefault against a real database", () => {
    let dataSource: DataSource | undefined

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy()
    })

    async function boot(
        migrations: Parameters<typeof createDataSource>[0],
        config: Record<string, unknown>,
    ): Promise<DataSource> {
        const created = await createDataSource(migrations, {
            migrationsTransactionMode: "each",
        } as never)
        dataSource = installStrongMigrations(created, config as never)
        await dataSource.initialize()
        await resetSchema(dataSource)
        return dataSource
    }

    it("builds the index concurrently and still completes the migration", async () => {
        if (!isPostgres) return

        const Migration = defineMigration("AddIndexRewritten", {
            async up(queryRunner) {
                await queryRunner.query(
                    `CREATE INDEX "IDX_users_email" ON "users" ("email")`,
                )
            },
        })

        const ds = await boot([Migration], { safeByDefault: true })
        await expect(ds.runMigrations()).resolves.toHaveLength(1)

        const runner = ds.createQueryRunner()
        try {
            const indexes = await runner.query(
                `SELECT indexdef FROM pg_indexes WHERE indexname = 'IDX_users_email'`,
            )
            expect(indexes).toHaveLength(1)

            // The migration must still be recorded, which is what the transaction
            // re-open exists to make possible.
            const applied = await runner.query(`SELECT name FROM "migrations"`)
            expect(applied).toHaveLength(1)
        } finally {
            await runner.release()
        }
    })

    it("adds a foreign key without validating under lock, then validates it", async () => {
        if (!isPostgres) return

        const Migration = defineMigration("AddForeignKeyRewritten", {
            async up(queryRunner) {
                await queryRunner.query(
                    `ALTER TABLE "orders" ADD CONSTRAINT "FK_orders_user" FOREIGN KEY ("user_id") REFERENCES "users"("id")`,
                )
            },
        })

        const ds = await boot([Migration], { safeByDefault: true })
        await expect(ds.runMigrations()).resolves.toHaveLength(1)

        const runner = ds.createQueryRunner()
        try {
            const rows = await runner.query(
                `SELECT convalidated FROM pg_constraint WHERE conname = 'FK_orders_user'`,
            )
            expect(rows).toHaveLength(1)
            // Added NOT VALID, then validated — so it ends up valid either way.
            expect(rows[0].convalidated).toBe(true)
        } finally {
            await runner.release()
        }
    })

    it("sets NOT NULL without a full scan under an exclusive lock", async () => {
        if (!isPostgres) return

        const Migration = defineMigration("SetNotNullRewritten", {
            async up(queryRunner) {
                await queryRunner.query(
                    `ALTER TABLE "users" ALTER COLUMN "email" SET NOT NULL`,
                )
            },
        })

        const ds = await boot([Migration], { safeByDefault: true })
        await expect(ds.runMigrations()).resolves.toHaveLength(1)

        const runner = ds.createQueryRunner()
        try {
            const rows = await runner.query(
                `SELECT is_nullable FROM information_schema.columns
                 WHERE table_name = 'users' AND column_name = 'email'`,
            )
            expect(rows[0].is_nullable).toBe("NO")

            // The proving constraint is dropped again once NOT NULL is set.
            const constraints = await runner.query(
                `SELECT conname FROM pg_constraint WHERE conname = 'users_email_null'`,
            )
            expect(constraints).toHaveLength(0)
        } finally {
            await runner.release()
        }
    })
})

describe("autoAnalyze", () => {
    let dataSource: DataSource | undefined

    afterEach(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy()
    })

    it("analyzes the table after an index is created", async () => {
        if (!isPostgres) return

        const Migration = defineMigration("AddIndexAnalyzed", {
            transaction: false,
            async up(queryRunner) {
                await queryRunner.query(
                    `CREATE INDEX CONCURRENTLY "IDX_users_email" ON "users" ("email")`,
                )
            },
        })

        const created = await createDataSource([Migration], {
            migrationsTransactionMode: "each",
        } as never)
        dataSource = installStrongMigrations(created, { autoAnalyze: true })
        await dataSource.initialize()
        await resetSchema(dataSource)
        await dataSource.runMigrations()

        const runner = dataSource.createQueryRunner()
        try {
            const rows = await runner.query(
                `SELECT last_analyze, last_autoanalyze FROM pg_stat_user_tables WHERE relname = 'users'`,
            )
            expect(rows[0]?.last_analyze).not.toBeNull()
        } finally {
            await runner.release()
        }
    })
})
