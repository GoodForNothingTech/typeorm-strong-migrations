import type { DataSource, MigrationInterface, QueryRunner } from "typeorm"
import {
    createAdapter,
    reconcileMariaDb,
    versionWarning,
} from "../adapters/factory"
import type { MigrationMeta } from "../checks/types"
import { Checker } from "../runtime/checker"
import {
    attachToQueryRunner,
    currentChecker,
    detachFromQueryRunner,
    runWithChecker,
} from "../runtime/context"
import { finalizeMigration } from "../runtime/safe-methods"
import type { InstallRecord } from "../state"
import { state, warnOnce } from "../state"
import { createCheckedQueryRunner } from "./checked-query-runner"

const WRAPPED = Symbol.for("typeorm-strong-migrations.wrapped")

/**
 * Replaces each migration's up/down with a wrapper that establishes a checker and
 * hands the body a checked QueryRunner.
 *
 * Re-scanned at every entry point rather than done once: `buildMetadatas`
 * reassigns `dataSource.migrations`, so a set captured at install time would be
 * stale by the time migrations run.
 */
export function wrapAllMigrations(dataSource: DataSource): void {
    const migrations = dataSource.migrations as MigrationInterface[] | undefined
    if (!migrations) return

    for (const migration of migrations) {
        const marked = migration as unknown as Record<symbol, unknown>
        if (marked[WRAPPED]) continue
        Object.defineProperty(migration, WRAPPED, {
            value: true,
            enumerable: false,
            configurable: true,
        })

        const meta = migrationMeta(migration)

        for (const direction of ["up", "down"] as const) {
            const original = migration[direction]
            if (typeof original !== "function") continue
            Object.defineProperty(migration, direction, {
                configurable: true,
                writable: true,
                enumerable: false,
                value(this: MigrationInterface, queryRunner: QueryRunner) {
                    return runMigration(
                        dataSource,
                        meta,
                        direction,
                        queryRunner,
                        (checked) =>
                            (
                                original as (
                                    qr: QueryRunner,
                                ) => Promise<unknown>
                            ).call(this, checked),
                    )
                },
            })
        }
    }
}

function migrationMeta(migration: MigrationInterface): MigrationMeta {
    const name = String(
        migration.name ??
            (migration.constructor as { name?: string }).name ??
            "Migration",
    )
    // TypeORM requires a 13-digit timestamp suffix and throws without one, but the
    // wrapper must not be the thing that throws, so a bad name simply means
    // "no version" and startAfter never applies.
    const suffix = name.slice(-13)
    const timestamp = /^\d{13}$/.test(suffix)
        ? Number.parseInt(suffix, 10)
        : undefined
    const declared = (
        migration as { safetyAssured?: boolean | readonly string[] }
    ).safetyAssured

    return {
        name,
        timestamp,
        declaredTransaction: migration.transaction,
        instanceSafetyAssured: declared,
    }
}

async function runMigration(
    dataSource: DataSource,
    meta: MigrationMeta,
    direction: "up" | "down",
    queryRunner: QueryRunner,
    body: (queryRunner: QueryRunner) => Promise<unknown>,
): Promise<unknown> {
    const record = state().installs.get(dataSource)
    if (!record) return body(queryRunner)

    const name =
        record.config.name ?? String(dataSource.options.database ?? "default")
    if (record.config.skippedDataSources.includes(name))
        return body(queryRunner)

    // A migration invoked from inside another one reuses the outer checker, so
    // newTables bookkeeping and the one-time session setup are not restarted.
    const existing = currentChecker()
    if (existing && existing.dataSource === dataSource) return body(queryRunner)

    const adapter = reconcileMariaDb(
        createAdapter(dataSource.options.type, queryRunner, record.config),
        record.serverVersion,
        queryRunner,
    )
    adapter.setVersion(record.serverVersion)

    // The minimum versions used to be decorative: nothing called the check that
    // enforced them, so a server below the floor ran with silently weaker checks.
    const outdated = versionWarning(adapter)
    if (outdated) warnOnce(`min-version:${dataSource.options.type}`, outdated)

    if (!adapter.supported) {
        warnOnce(
            `unsupported-adapter:${dataSource.options.type}`,
            `[strong-migrations] Unsupported driver: ${dataSource.options.type}. ` +
                `Migrations will run unchecked. Use skipDataSource(${JSON.stringify(name)}) ` +
                `to silence this warning.`,
        )
        return body(queryRunner)
    }

    const checker = new Checker({
        dataSource,
        queryRunner,
        migration: meta,
        direction,
        config: record.config,
        adapter,
        transactionMode: record.transactionMode,
        transactionModeInferred: record.transactionModeInferred,
    })

    const checked = createCheckedQueryRunner(queryRunner, checker)
    attachToQueryRunner(queryRunner, checker)
    try {
        return await runWithChecker(checker, () => body(checked))
    } finally {
        detachFromQueryRunner(queryRunner, checker)
        // If a safeByDefault rewrite committed the transaction to run something
        // concurrently, re-open one so TypeORM's own commit does not fail.
        await finalizeMigration({
            queryRunner,
            transactionDisabled: checker.state.transactionDisabled,
        }).catch(() => {})
    }
}

export type { InstallRecord }
