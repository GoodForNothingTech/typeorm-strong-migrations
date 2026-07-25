import type { DataSource } from "typeorm"
import type { AnalyzeOptions } from "../sql/analyze"
import { analyzeSql } from "../sql/analyze"
import type { BookkeepingConfig } from "../sql/classify"
import { bookkeepingConfig, classify } from "../sql/classify"
import type { Dialect, Operation } from "./types"

/**
 * The primary detection path.
 *
 * `typeorm migration:generate` emits migration bodies made entirely of
 * `queryRunner.query(...)` calls — there are no typed DDL calls to intercept — so
 * without this the package would catch nothing in a generated migration.
 *
 * Bookkeeping statements are dropped here rather than in a check, because
 * suppressing them is unconditionally correct and no check should have to know
 * about the migrations table.
 */

/**
 * The table names come from immutable DataSource options, but this runs on every
 * intercepted statement — so it was rebuilding an object, and `isBookkeeping` a Set,
 * per query.
 */
const BOOKKEEPING_CACHE = new WeakMap<DataSource, BookkeepingConfig>()

function bookkeepingFor(dataSource: DataSource): BookkeepingConfig {
    const cached = BOOKKEEPING_CACHE.get(dataSource)
    if (cached) return cached
    const options = dataSource.options as {
        migrationsTableName?: string
        metadataTableName?: string
    }
    const config = bookkeepingConfig({
        migrationsTableName: options.migrationsTableName,
        metadataTableName: options.metadataTableName,
    })
    BOOKKEEPING_CACHE.set(dataSource, config)
    return config
}

export function operationsFromSql(
    sql: string,
    dialect: Dialect,
    dataSource: DataSource,
    options?: AnalyzeOptions,
): Operation[] {
    if (!sql) return []
    const config = bookkeepingFor(dataSource)

    return analyzeSql(sql, dialect, options).filter((op) => {
        const statementClass = classify(op, config)
        return statementClass !== "bookkeeping" && statementClass !== "benign"
    })
}
