import type { Dialect, TableRef } from "../operations/types"
import { formatSeconds, postgresTimeoutToMs } from "../util/duration"
import { atLeast, below } from "../util/version"
import { quoteIdent, quoteTable } from "../util/sql"
import { AbstractAdapter } from "./abstract"
import type { Introspector, TypeChangeInput } from "./types"

export class PostgresAdapter extends AbstractAdapter {
    readonly key = "postgres" as const
    readonly name = "PostgreSQL"
    readonly dialect: Dialect = "postgres"
    override readonly minVersion = "12"

    // Postgres 11+ writes a fast default without rewriting the table, so this is
    // true for every version we support. The addColumnDefault check therefore
    // narrows to the volatile-uuid case rather than firing on any default.
    override readonly addColumnDefaultSafe = true
    override readonly rewriteBlocks = "reads and writes" as const
    override readonly autoIncrementingTypes = [
        "serial",
        "bigserial",
        "smallserial",
        "primary_key",
    ]
    override readonly maxConstraintNameLength = 63
    override readonly supportsConcurrentIndex = true
    override readonly supportsNotValidConstraints = true

    override async setStatementTimeout(ms: number): Promise<void> {
        await this.exec(`SET statement_timeout TO ${Math.ceil(ms)}`)
    }

    override async setLockTimeout(ms: number): Promise<void> {
        await this.exec(`SET lock_timeout TO ${Math.ceil(ms)}`)
    }

    override async setTransactionTimeout(ms: number): Promise<void> {
        if (!this.supportsTransactionTimeout()) return
        await this.exec(`SET transaction_timeout TO ${Math.ceil(ms)}`)
    }

    override supportsTransactionTimeout(): boolean {
        return atLeast(this.serverVersion, "17")
    }

    override async lockTimeoutWarnings(limitMs: number): Promise<string[]> {
        try {
            const rows = await this.rows("SHOW lock_timeout")
            const raw = rows[0]
                ? String(rows[0].lock_timeout ?? Object.values(rows[0])[0])
                : undefined
            if (raw === undefined) return []
            const ms = postgresTimeoutToMs(raw)
            if (ms === undefined) return []
            if (ms === 0)
                return ["[strong-migrations] DANGER: No lock timeout set"]
            if (ms > limitMs) {
                return [
                    `[strong-migrations] DANGER: Lock timeout is longer than ${formatSeconds(limitMs)} seconds: ${raw}`,
                ]
            }
            return []
        } catch {
            return []
        }
    }

    override async analyzeTable(table: TableRef): Promise<void> {
        await this.exec(`ANALYZE ${quoteTable(table, "postgres")}`)
    }

    /** Postgres 14.0 through 14.3 can silently corrupt a concurrently-built index. */
    override hasIndexCorruptionBug(developerEnv: boolean): boolean {
        if (developerEnv) return false
        return (
            atLeast(this.serverVersion, "14") &&
            below(this.serverVersion, "14.4")
        )
    }

    /**
     * Ported from strong_migrations' postgresql_adapter.rb `change_type_safe?`.
     * Anything not listed is unsafe — the matrix is an allowlist by design.
     */
    override async changeTypeSafe(
        input: TypeChangeInput,
        introspect: Introspector,
    ): Promise<boolean> {
        const { oldType, newType, table, column } = input
        const from = oldType.baseType
        const to = newType.baseType

        const indexed = async (): Promise<boolean> => {
            const result = await introspect.isIndexed(table, column)
            // Unknown counts as indexed: refusing is the safe direction.
            return result !== false
        }

        switch (to) {
            case "character varying":
                if (from === "character varying") {
                    return (
                        newType.length === undefined ||
                        (oldType.length !== undefined &&
                            newType.length >= oldType.length)
                    )
                }
                if (from === "text") return newType.length === undefined
                if (from === "citext")
                    return newType.length === undefined && !(await indexed())
                return false

            case "text":
                if (from === "character varying" || from === "text") return true
                if (from === "citext") return !(await indexed())
                return false

            case "citext":
                if (from === "character varying" || from === "text")
                    return !(await indexed())
                return false

            // No way to set the limit on an existing bit varying column.
            case "bit varying":
                return false

            case "numeric":
                if (from !== "numeric") return false
                if (
                    newType.precision === undefined &&
                    newType.scale === undefined
                )
                    return true
                return (
                    newType.precision !== undefined &&
                    oldType.precision !== undefined &&
                    newType.precision >= oldType.precision &&
                    (newType.scale ?? 0) === (oldType.scale ?? 0)
                )

            case "timestamp without time zone":
            case "timestamp with time zone": {
                if (
                    from !== "timestamp without time zone" &&
                    from !== "timestamp with time zone"
                ) {
                    return false
                }
                const newPrecision = newType.precision ?? 6
                const oldPrecision = oldType.precision ?? 6
                if (newPrecision < oldPrecision) return false
                if (from === to) return true
                // Crossing the time-zone boundary only avoids a rewrite when the
                // session is already UTC, so the stored values do not move.
                const zone = await introspect.timeZone()
                return zone !== undefined && zone.toUpperCase() === "UTC"
            }

            case "time without time zone": {
                if (from !== "time without time zone") return false
                return (newType.precision ?? 6) >= (oldType.precision ?? 6)
            }

            // Setting a precision on timetz always rewrites.
            case "time with time zone":
                return false

            case "interval":
                if (from !== "interval") return false
                return (newType.precision ?? 6) >= (oldType.precision ?? 6)

            case "inet":
                return from === "cidr"

            default:
                return false
        }
    }
}

/** Constraint name the gem generates for a NOT NULL check, matching the `rein` gem. */
export function notNullConstraintName(
    table: TableRef,
    column: string,
    maxLength: number,
): string {
    const name = `${table.name}_${column}_null`
    if (name.length <= maxLength) return name
    return name.slice(0, maxLength)
}

export function quotedColumn(column: string): string {
    return quoteIdent(column, "postgres")
}
