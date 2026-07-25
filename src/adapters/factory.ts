import type { DataSource, QueryRunner } from "typeorm"
import type { ResolvedConfig, SupportedDatabase } from "../config"
import { resolvedTargetVersion } from "../config"
import { MariaDbAdapter, MysqlAdapter } from "./mysql"
import { PostgresAdapter } from "./postgres"
import type { Adapter } from "./types"
import { UnsupportedAdapter } from "./unsupported"
import { isMariaDbVersion, atLeast } from "../util/version"

/**
 * `aurora-*` are the same engines behind a different driver, so they map to the
 * base adapter. CockroachDB is deliberately *not* mapped onto Postgres: it does
 * online schema changes, so most of these checks would be false positives, and
 * there is no reference implementation to port.
 */
const DRIVER_MAP: Record<string, SupportedDatabase> = {
    postgres: "postgres",
    "aurora-postgres": "postgres",
    mysql: "mysql",
    "aurora-mysql": "mysql",
    mariadb: "mariadb",
}

export function databaseTypeFor(
    driverType: string,
): SupportedDatabase | undefined {
    return DRIVER_MAP[driverType]
}

export function createAdapter(
    driverType: string,
    queryRunner: QueryRunner,
    config?: ResolvedConfig,
): Adapter {
    switch (databaseTypeFor(driverType)) {
        case "postgres":
            return new PostgresAdapter(queryRunner)
        case "mysql":
            return withSqlMode(new MysqlAdapter(queryRunner), config)
        case "mariadb":
            return withSqlMode(new MariaDbAdapter(queryRunner), config)
        default:
            return new UnsupportedAdapter(queryRunner, driverType)
    }
}

/**
 * Applies `targetSqlMode`, honouring the same development-only gate that
 * `resolvedTargetVersion` applies to `targetVersion`: production always reads the
 * mode from the server it is actually talking to.
 */
function withSqlMode(adapter: MysqlAdapter, config?: ResolvedConfig): Adapter {
    if (config?.developerEnv && config.targetSqlMode) {
        adapter.targetSqlMode = config.targetSqlMode
    }
    return adapter
}

/**
 * Resolves the server version once, outside any transaction.
 *
 * Under `migrationsTransactionMode: "all"` a single transaction spans the whole
 * batch, so a failure part-way puts Postgres in an aborted state where even our
 * own `SHOW server_version_num` would fail. `driver.version` is populated during
 * `driver.connect()`, before any of that, so it is both free and reliable.
 */
export async function resolveServerVersion(
    dataSource: DataSource,
    adapter: Adapter,
    config: ResolvedConfig,
): Promise<string | undefined> {
    const database = databaseTypeFor(dataSource.options.type)
    if (database) {
        const target = resolvedTargetVersion(config, database)
        if (target) return target
    }

    const fromDriver = (dataSource.driver as { version?: string }).version
    if (fromDriver) return fromDriver

    let runner: QueryRunner | undefined
    try {
        runner = dataSource.createQueryRunner()
        const withGetVersion = runner as unknown as {
            getVersion?: () => Promise<string>
        }
        if (typeof withGetVersion.getVersion === "function") {
            return await withGetVersion.getVersion()
        }
        if (adapter.key === "postgres") {
            const rows = await runner.query("SHOW server_version")
            const row = Array.isArray(rows) ? rows[0] : undefined
            return row
                ? String(row.server_version ?? Object.values(row)[0])
                : undefined
        }
        const rows = await runner.query("SELECT VERSION() AS version")
        const row = Array.isArray(rows) ? rows[0] : undefined
        return row ? String(row.version ?? Object.values(row)[0]) : undefined
    } catch {
        return undefined
    } finally {
        if (runner) await runner.release().catch(() => {})
    }
}

/**
 * The driver says "mysql" for both engines in some setups; the version string is
 * the reliable discriminator.
 */
export function reconcileMariaDb(
    adapter: Adapter,
    version: string | undefined,
    queryRunner: QueryRunner,
): Adapter {
    if (adapter.key === "mysql" && isMariaDbVersion(version)) {
        // A fresh instance, not `setPrototypeOf`: `key`, `name`, `dialect` and
        // `minVersion` are class fields, so they are own properties assigned by the
        // MysqlAdapter constructor. Re-pointing the prototype swaps the methods but
        // leaves every one of those still reading "mysql"/"8.0", which is how a
        // MariaDB server ended up with `dialect: "mysql"` in every check and message.
        const upgraded = new MariaDbAdapter(queryRunner)
        upgraded.setVersion(version)
        return upgraded
    }
    return adapter
}

/**
 * Warns once when the server predates the minimum this package was written against.
 *
 * The gem raises here. We warn instead: several checks are version-gated, so the user
 * should know their results are weaker than advertised — but failing an entire
 * migration run over a server version is a worse outcome than the thing being
 * reported. Returns the message so callers can route it through their own logger.
 */
export function versionWarning(adapter: Adapter): string | undefined {
    if (!adapter.supported || !adapter.minVersion) return undefined
    const version = adapter.version()
    // An unknown version is not grounds for complaining.
    if (!version) return undefined
    if (atLeast(version, adapter.minVersion)) return undefined
    return (
        `[strong-migrations] ${adapter.name} ${version} is older than the minimum this ` +
        `package targets (${adapter.minVersion}). Checks will still run, but the ones ` +
        `gated on server version may not reflect your server.`
    )
}
