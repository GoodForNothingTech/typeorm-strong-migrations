import { describe, expect, it } from "vitest"
import { StrongMigrationsConfigError } from "../../src/errors"
import { runMigration } from "../helpers/assertions"

/**
 * safeByDefault rewrites the operation instead of rejecting it.
 *
 * It has to commit the ambient transaction to run anything CONCURRENTLY, which is
 * only sound when each migration owns its own transaction. Under
 * `migrationsTransactionMode: "all"` a mid-batch commit would also commit every
 * other migration's work, so it refuses rather than doing something surprising.
 */
describe("safeByDefault", () => {
    const CONFIG = { safeByDefault: true }

    it("rewrites a non-concurrent index into a concurrent one", async () => {
        const executed = await runMigration(
            (qr) =>
                qr.query('CREATE INDEX "IDX_users_email" ON "users" ("email")'),
            { config: CONFIG, transactionMode: "each" },
        )
        expect(
            executed.some((sql) => /CREATE INDEX CONCURRENTLY/.test(sql)),
        ).toBe(true)
        // The original, unsafe statement must not also run.
        expect(executed.some((sql) => /^CREATE INDEX "IDX/.test(sql))).toBe(
            false,
        )
    })

    it("rewrites a dropped index into a concurrent drop", async () => {
        const executed = await runMigration(
            (qr) => qr.query('DROP INDEX "IDX_users_email"'),
            {
                config: { ...CONFIG, enabledChecks: { dropIndex: true } },
                transactionMode: "each",
            },
        )
        expect(
            executed.some((sql) => /DROP INDEX CONCURRENTLY/.test(sql)),
        ).toBe(true)
    })

    it("rewrites a foreign key into NOT VALID plus VALIDATE", async () => {
        const executed = await runMigration(
            (qr) =>
                qr.query(
                    `ALTER TABLE "account" ADD CONSTRAINT "FK_1" FOREIGN KEY ("userId") REFERENCES "user"("id")`,
                ),
            { config: CONFIG, transactionMode: "each" },
        )
        expect(executed.some((sql) => /NOT VALID/.test(sql))).toBe(true)
        expect(executed.some((sql) => /VALIDATE CONSTRAINT/.test(sql))).toBe(
            true,
        )
    })

    it("rewrites SET NOT NULL into the constraint dance", async () => {
        const executed = await runMigration(
            (qr) =>
                qr.query(
                    `ALTER TABLE "users" ALTER COLUMN "name" SET NOT NULL`,
                ),
            { config: CONFIG, transactionMode: "each" },
        )
        // Prove the invariant first, then flip the flag without a full scan.
        expect(
            executed.some((sql) => /IS NOT NULL\) NOT VALID/.test(sql)),
        ).toBe(true)
        expect(executed.some((sql) => /VALIDATE CONSTRAINT/.test(sql))).toBe(
            true,
        )
        expect(executed.some((sql) => /SET NOT NULL/.test(sql))).toBe(true)
        expect(executed.some((sql) => /DROP CONSTRAINT/.test(sql))).toBe(true)
    })

    it("refuses under transaction mode all rather than committing other migrations' work", async () => {
        await expect(
            runMigration(
                (qr) =>
                    qr.query(
                        'CREATE INDEX "IDX_users_email" ON "users" ("email")',
                    ),
                {
                    config: CONFIG,
                    transactionMode: "all",
                },
            ),
        ).rejects.toThrow(StrongMigrationsConfigError)
    })

    it("leaves an already-safe operation alone", async () => {
        const executed = await runMigration(
            (qr) =>
                qr.query(
                    'CREATE INDEX CONCURRENTLY "IDX_users_email" ON "users" ("email")',
                ),
            { config: CONFIG, transactionMode: "each" },
        )
        expect(executed).toEqual([
            'CREATE INDEX CONCURRENTLY "IDX_users_email" ON "users" ("email")',
        ])
    })

    it("does not rewrite on MySQL, which has no concurrent index build", async () => {
        const executed = await runMigration(
            (qr) =>
                qr.query("CREATE INDEX `IDX_users_email` ON `users` (`email`)"),
            { config: CONFIG, dialect: "mysql", transactionMode: "each" },
        )
        expect(executed).toEqual([
            "CREATE INDEX `IDX_users_email` ON `users` (`email`)",
        ])
    })
})
