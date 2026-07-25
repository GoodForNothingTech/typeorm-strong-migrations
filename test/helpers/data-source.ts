import { DataSource } from "typeorm"
import type { DataSourceOptions } from "typeorm"

/**
 * Integration DataSource, driven by ADAPTER the way the gem's suite is driven by
 * its own ADAPTER env var. Ports match docker-compose.yml, where MariaDB sits on
 * 3307 so both MySQL engines can run at once.
 */
export type Adapter = "postgres" | "mysql" | "mariadb"

export const ADAPTER = (process.env.ADAPTER ?? "postgres") as Adapter

export const isPostgres = ADAPTER === "postgres"
export const isMysql = ADAPTER === "mysql"
export const isMariadb = ADAPTER === "mariadb"
export const isMysqlFamily = isMysql || isMariadb

// TypeORM instantiates these itself (ConnectionMetadataBuilder.buildMigrations does
// `new migrationClass()`), so options.migrations holds classes, not instances.
export type MigrationClass = new () => object

export function baseOptions(
    migrations: MigrationClass[] = [],
): DataSourceOptions {
    const shared = {
        migrations,
        synchronize: false,
        migrationsRun: false,
        logging: false as const,
    }

    if (isPostgres) {
        return {
            type: "postgres",
            host: process.env.PGHOST ?? "localhost",
            port: Number(process.env.PGPORT ?? 5432),
            username: process.env.PGUSER ?? "username",
            password: process.env.PGPASSWORD ?? "password",
            database: process.env.PGDATABASE ?? "strong_migrations_test",
            ...shared,
        }
    }

    return {
        type: isMariadb ? "mariadb" : "mysql",
        host: process.env.MYSQL_HOST ?? "localhost",
        port: Number(process.env.MYSQL_PORT ?? (isMariadb ? 3307 : 3306)),
        username: process.env.MYSQL_USER ?? "root",
        password: process.env.MYSQL_PASSWORD ?? "admin",
        database: process.env.MYSQL_DATABASE ?? "strong_migrations_test",
        ...shared,
    }
}

export async function createDataSource(
    migrations: MigrationClass[] = [],
    overrides: Partial<DataSourceOptions> = {},
): Promise<DataSource> {
    return new DataSource({
        ...baseOptions(migrations),
        ...overrides,
    } as DataSourceOptions)
}

/** The fixture schema every integration test runs against. */
export async function resetSchema(dataSource: DataSource): Promise<void> {
    const runner = dataSource.createQueryRunner()
    try {
        for (const table of ["orders", "users", "migrations"]) {
            await runner
                .query(`DROP TABLE IF EXISTS ${quote(table)}`)
                .catch(() => {})
        }
        await runner.query(
            isPostgres
                ? `CREATE TABLE "users" ("id" SERIAL PRIMARY KEY, "email" varchar(100), "name" varchar(100), "active" boolean)`
                : "CREATE TABLE `users` (`id` int NOT NULL AUTO_INCREMENT PRIMARY KEY, `email` varchar(100), `name` varchar(100), `active` tinyint)",
        )
        await runner.query(
            isPostgres
                ? `CREATE TABLE "orders" ("id" SERIAL PRIMARY KEY, "user_id" integer)`
                : "CREATE TABLE `orders` (`id` int NOT NULL AUTO_INCREMENT PRIMARY KEY, `user_id` int)",
        )
    } finally {
        await runner.release()
    }
}

export function quote(identifier: string): string {
    return isPostgres ? `"${identifier}"` : `\`${identifier}\``
}

export async function serverVersion(dataSource: DataSource): Promise<string> {
    const runner = dataSource.createQueryRunner()
    try {
        const rows = await runner.query(
            isPostgres ? "SHOW server_version" : "SELECT VERSION() AS version",
        )
        const row = Array.isArray(rows) ? rows[0] : undefined
        return String(row?.server_version ?? row?.version ?? "")
    } finally {
        await runner.release()
    }
}
