import type { MigrationInterface, QueryRunner } from "typeorm"
import type { StrongMigrationsConfig } from "../config"
import { baseConfig, mergeConfig } from "../config"
import { state } from "../state"

/**
 * Helpers for testing migrations. Published as `typeorm-strong-migrations/testing`
 * so they stay out of the main entry point.
 */

export interface MigrationDefinition {
    up(queryRunner: QueryRunner): Promise<void>
    down?(queryRunner: QueryRunner): Promise<void>
    transaction?: boolean
    safetyAssured?: boolean | readonly string[]
    /** 13-digit ms epoch. Defaults to a fixed value so tests stay deterministic. */
    timestamp?: number
}

export type MigrationClass = new () => MigrationInterface

const DEFAULT_TIMESTAMP = 1_700_000_000_000

/**
 * Builds a migration class with a valid name.
 *
 * TypeORM requires a 13-digit timestamp suffix — `MigrationExecutor.getMigrations`
 * does `parseInt(name.slice(-13))` and throws otherwise — which makes hand-writing
 * fixtures tedious and makes `startAfter` awkward to vary. Here the timestamp is a
 * parameter rather than part of an identifier.
 */
export function defineMigration(
    baseName: string,
    definition: MigrationDefinition,
): MigrationClass {
    const timestamp = definition.timestamp ?? DEFAULT_TIMESTAMP
    const className = `${baseName}${timestamp}`

    class GeneratedMigration implements MigrationInterface {
        name = className
        transaction = definition.transaction
        safetyAssured = definition.safetyAssured

        async up(queryRunner: QueryRunner): Promise<void> {
            await definition.up(queryRunner)
        }

        async down(queryRunner: QueryRunner): Promise<void> {
            await definition.down?.(queryRunner)
        }
    }

    Object.defineProperty(GeneratedMigration, "name", { value: className })
    return GeneratedMigration as MigrationClass
}

/**
 * Runs `fn` with config layered over the current module-level config, restoring it
 * afterwards. The gem's `with_option` helper, generalized.
 */
export async function withConfig<T>(
    config: StrongMigrationsConfig,
    fn: () => Promise<T> | T,
): Promise<T> {
    const store = state()
    const previous = store.config
    store.config = mergeConfig(previous, config)
    try {
        return await fn()
    } finally {
        store.config = previous
    }
}

export async function withStartAfter<T>(
    startAfter: number,
    fn: () => Promise<T> | T,
): Promise<T> {
    return withConfig({ startAfter }, fn)
}

export async function withEnv<T>(
    env: string,
    fn: () => Promise<T> | T,
): Promise<T> {
    return withConfig({ env }, fn)
}

export async function withTargetVersion<T>(
    targetVersion: string | number,
    fn: () => Promise<T> | T,
): Promise<T> {
    // targetVersion is honored in development/test only, so pin the env too.
    return withConfig({ targetVersion, env: "test" }, fn)
}

/** Restores the module singleton. */
export function resetStrongMigrations(): void {
    const store = state()
    store.config = baseConfig()
    store.warned.clear()
}
