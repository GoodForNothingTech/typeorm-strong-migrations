import { expect } from "vitest"
import type { QueryRunner } from "typeorm"
import { createAdapter } from "../../src/adapters/factory"
import type { MigrationMeta, TransactionMode } from "../../src/checks/types"
import type { StrongMigrationsConfig } from "../../src/config"
import { mergeConfig } from "../../src/config"
import {
    AggregateUnsafeMigrationError,
    UnsafeMigrationError,
} from "../../src/errors"
import { createCheckedQueryRunner } from "../../src/install/checked-query-runner"
import { Checker } from "../../src/runtime/checker"
import { attachToQueryRunner, runWithChecker } from "../../src/runtime/context"
import { state } from "../../src/state"
import type { FakeOptions } from "./fake-query-runner"
import { createFakeRunner } from "./fake-query-runner"

/**
 * Mirrors strong_migrations' test_helper.rb: run a migration body and assert it was
 * accepted or rejected. Everything goes through the real Checker and the real
 * QueryRunner proxy, so what these tests exercise is the production path.
 */

export interface RunOptions extends FakeOptions {
    config?: StrongMigrationsConfig
    direction?: "up" | "down"
    /** 13-digit ms epoch, for startAfter tests. */
    version?: number
    migrationName?: string
    transactionMode?: TransactionMode
    declaredTransaction?: boolean
    safetyAssured?: boolean | readonly string[]
    serverVersion?: string
}

const DEFAULT_VERSION = 1_700_000_000_000

export type MigrationBody = (queryRunner: QueryRunner) => Promise<void>

export async function runMigration(
    body: MigrationBody,
    options: RunOptions = {},
): Promise<string[]> {
    const fake = createFakeRunner(options)
    const config = mergeConfig(state().config, options.config ?? {})

    const meta: MigrationMeta = {
        name:
            options.migrationName ??
            `TestMigration${options.version ?? DEFAULT_VERSION}`,
        timestamp: options.version ?? DEFAULT_VERSION,
        declaredTransaction: options.declaredTransaction,
        instanceSafetyAssured: options.safetyAssured,
    }

    const adapter = createAdapter(
        options.dialect ?? "postgres",
        fake.queryRunner,
    )
    adapter.setVersion(
        options.serverVersion ??
            (options.dialect === "postgres" || !options.dialect
                ? "16.2"
                : "8.4.0"),
    )

    const checker = new Checker({
        dataSource: fake.dataSource,
        queryRunner: fake.queryRunner,
        migration: meta,
        direction: options.direction ?? "up",
        config,
        adapter,
        transactionMode: options.transactionMode ?? "each",
        transactionModeInferred: false,
    })

    const checked = createCheckedQueryRunner(fake.queryRunner, checker)
    attachToQueryRunner(fake.queryRunner, checker)
    await runWithChecker(checker, () => body(checked))
    // Only what the migration ran. Session setup — timeouts, the sql_mode probe the
    // lexer needs — is our own traffic and would otherwise show up in every
    // assertion about what a migration executed.
    return fake.executed.filter((sql) => !isSessionSetup(sql))
}

const SESSION_SETUP =
    /^\s*(SET\s|SHOW\s|SELECT @@|SELECT version\(\)|ANALYZE\b)/i

function isSessionSetup(sql: string): boolean {
    return SESSION_SETUP.test(sql)
}

/** Asserts the migration is rejected, and optionally that the message matches. */
export async function assertUnsafe(
    body: MigrationBody,
    matcher?: string | RegExp,
    options: RunOptions = {},
): Promise<UnsafeMigrationError> {
    let caught: unknown
    try {
        await runMigration(body, options)
    } catch (error) {
        caught = error
    }

    if (caught === undefined) {
        expect.fail(
            "Expected the migration to be rejected, but it was allowed.",
        )
    }
    if (caught instanceof AggregateUnsafeMigrationError) {
        const first = caught.errors[0]!
        if (matcher) expect(caught.message).toMatch(matcher)
        return first
    }
    if (!(caught instanceof UnsafeMigrationError)) throw caught
    if (matcher) expect(caught.message).toMatch(matcher)
    return caught
}

/** Asserts the migration is allowed. With no direction, runs both up and down. */
export async function assertSafe(
    body: MigrationBody,
    options: RunOptions = {},
): Promise<void> {
    if (options.direction) {
        await runMigration(body, options)
        return
    }
    await runMigration(body, { ...options, direction: "up" })
    await runMigration(body, {
        ...options,
        direction: "down",
        config: { ...options.config, checkDown: true },
    })
}

/** Collects every error raised, for statements that fail more than one check. */
export async function collectErrors(
    body: MigrationBody,
    options: RunOptions = {},
): Promise<UnsafeMigrationError[]> {
    try {
        await runMigration(body, options)
        return []
    } catch (error) {
        if (error instanceof AggregateUnsafeMigrationError)
            return [...error.errors]
        if (error instanceof UnsafeMigrationError) return [error]
        throw error
    }
}
