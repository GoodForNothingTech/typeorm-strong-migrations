import type { Dialect, TableRef } from "../operations/types"
import { formatSeconds } from "../util/duration"
import { quoteTable } from "../util/sql"
import { AbstractAdapter } from "./abstract"
import type { Introspector, TypeChangeInput } from "./types"

export class MysqlAdapter extends AbstractAdapter {
    readonly key: Dialect | "unsupported" = "mysql"
    readonly name: string = "MySQL"
    readonly dialect: Dialect = "mysql"
    override readonly minVersion: string = "8.0"

    // MySQL 8.0.12+ supports instant ADD COLUMN with a default.
    override readonly addColumnDefaultSafe = true
    // MySQL's online DDL keeps reads available during most rewrites.
    override readonly rewriteBlocks = "writes" as const
    override readonly autoIncrementingTypes = ["primary_key"]
    override readonly maxConstraintNameLength = 64
    override readonly supportsConcurrentIndex = false
    override readonly supportsNotValidConstraints = false

    /** Development-only override so a check can be exercised without the server. */
    targetSqlMode: string | null = null

    override async setStatementTimeout(ms: number): Promise<void> {
        await this.exec(`SET max_execution_time = ${Math.ceil(ms)}`)
    }

    override async setLockTimeout(ms: number): Promise<void> {
        // lock_wait_timeout is whole seconds, minimum 1.
        await this.exec(
            `SET lock_wait_timeout = ${Math.max(1, Math.ceil(ms / 1000))}`,
        )
    }

    override async lockTimeoutWarnings(limitMs: number): Promise<string[]> {
        try {
            const rows = await this.rows(
                "SHOW VARIABLES LIKE 'lock_wait_timeout'",
            )
            const value = rows[0]?.Value ?? rows[0]?.value
            if (value === undefined) return []
            const seconds = Number(value)
            if (!Number.isFinite(seconds)) return []
            if (seconds * 1000 > limitMs) {
                return [
                    `[strong-migrations] DANGER: Lock timeout is longer than ${formatSeconds(limitMs)} seconds: ${seconds}`,
                ]
            }
            return []
        } catch {
            return []
        }
    }

    override async analyzeTable(table: TableRef): Promise<void> {
        await this.exec(`ANALYZE TABLE ${quoteTable(table, this.dialect)}`)
    }

    /** NOT NULL is only enforced under strict mode; otherwise NULLs become defaults. */
    /**
     * Cached because the lexer needs it synchronously: parsing happens inside the
     * QueryRunner proxy, before anything can await.
     */
    private cachedSqlMode: string | undefined

    /**
     * How this session spells quoting and escaping.
     *
     * Under ANSI_QUOTES a double-quoted word is an identifier rather than a string,
     * so lexing `ALTER TABLE "users"` with the wrong assumption yields a bogus table.
     * `ANSI` is a composite mode that implies ANSI_QUOTES, so a plain
     * `includes("ANSI_QUOTES")` misses it.
     */
    override lexerOptions(): {
        ansiQuotes: boolean
        noBackslashEscapes: boolean
    } {
        const mode = this.targetSqlMode ?? this.cachedSqlMode ?? ""
        return {
            ansiQuotes:
                /ANSI_QUOTES/.test(mode) || /(^|,)\s*ANSI\s*(,|$)/.test(mode),
            noBackslashEscapes: /NO_BACKSLASH_ESCAPES/.test(mode),
        }
    }

    /** Resolved once at session setup, outside any transaction. */
    override async warmSessionFacts(): Promise<void> {
        if (this.cachedSqlMode !== undefined) return
        this.cachedSqlMode = (await this.readSqlMode()) ?? ""
    }

    override async strictMode(): Promise<boolean | undefined> {
        try {
            const mode =
                this.targetSqlMode ??
                this.cachedSqlMode ??
                (await this.readSqlMode())
            if (mode === undefined) return undefined
            return /STRICT_ALL_TABLES|STRICT_TRANS_TABLES/.test(mode)
        } catch {
            return undefined
        }
    }

    private async readSqlMode(): Promise<string | undefined> {
        const rows = await this.rows("SELECT @@SESSION.sql_mode AS sql_mode")
        const value = rows[0]?.sql_mode
        return value === undefined ? undefined : String(value)
    }

    /**
     * MySQL only avoids a rewrite when widening a varchar, and only while the
     * number of bytes used to store the length prefix stays the same. Ported from
     * strong_migrations' mysql_adapter.rb.
     */
    override async changeTypeSafe(
        input: TypeChangeInput,
        introspect: Introspector,
    ): Promise<boolean> {
        const { oldType, newType, table, column } = input
        if (
            newType.baseType !== "varchar" &&
            newType.baseType !== "character varying"
        )
            return false
        if (
            oldType.baseType !== "varchar" &&
            oldType.baseType !== "character varying"
        )
            return false

        const newLength = newType.length ?? 255
        const oldLength = oldType.length
        if (oldLength === undefined || newLength < oldLength) return false

        const maxLen = await introspect.charsetMaxLen(table, column)
        // The gem warns and stays unsafe when the charset cannot be determined.
        if (maxLen === undefined || maxLen === 0) return false

        const threshold = Math.floor(255 / maxLen)
        return newLength <= threshold || oldLength > threshold
    }
}

export class MariaDbAdapter extends MysqlAdapter {
    override readonly key: Dialect | "unsupported" = "mariadb"
    override readonly name: string = "MariaDB"
    override readonly dialect: Dialect = "mariadb"
    override readonly minVersion: string = "10.5"

    /** MariaDB spells it max_statement_time, and takes seconds rather than ms. */
    override async setStatementTimeout(ms: number): Promise<void> {
        await this.exec(`SET max_statement_time = ${ms / 1000}`)
    }
}
