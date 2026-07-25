import type {
    ColumnSpec,
    Dialect,
    SqlType,
    TableRef,
} from "../operations/types"

export interface PgConstraint {
    name: string
    /** 'c' = check, 'f' = foreign key, 'u' = unique, 'p' = primary key, 'x' = exclusion */
    type: string
    definition: string
    validated: boolean
}

/** Live database facts a check may need. Every method degrades rather than throwing. */
export interface Introspector {
    /** Columns of an existing table, or `undefined` when it cannot be determined. */
    columns(table: TableRef): Promise<ColumnSpec[] | undefined>
    column(table: TableRef, name: string): Promise<ColumnSpec | undefined>
    isIndexed(table: TableRef, column: string): Promise<boolean | undefined>
    checkConstraintsOnColumn(
        table: TableRef,
        column: string,
    ): Promise<PgConstraint[] | undefined>
    constraint(table: TableRef, name: string): Promise<PgConstraint | undefined>
    /** Whether this session currently holds a write-blocking lock. */
    writesBlocked(): Promise<boolean | undefined>
    /** Postgres `pg_proc.provolatile`. Unknown functions count as volatile. */
    isVolatileFunction(name: string, schema?: string): Promise<boolean>
    /** MySQL charset MAXLEN for a column, used by the varchar-widening rule. */
    charsetMaxLen(table: TableRef, column: string): Promise<number | undefined>
    invalidIndexExists(
        name: string,
        schema?: string,
    ): Promise<boolean | undefined>
    /** Session time zone; the gem deliberately refetches rather than memoizing. */
    timeZone(): Promise<string | undefined>
}

export interface TypeChangeInput {
    table: TableRef
    column: string
    oldType: SqlType
    newType: SqlType
}

export interface Adapter {
    readonly key: Dialect | "unsupported"
    readonly name: string
    readonly dialect: Dialect
    readonly minVersion?: string
    readonly supported: boolean

    /** Resolved once at install, outside any transaction. */
    version(): string | undefined
    setVersion(version: string | undefined): void

    setStatementTimeout(ms: number): Promise<void>
    setTransactionTimeout(ms: number): Promise<void>
    setLockTimeout(ms: number): Promise<void>
    /** Returns warnings; never throws. */
    lockTimeoutWarnings(limitMs: number): Promise<string[]>
    analyzeTable(table: TableRef): Promise<void>

    /**
     * True for every supported engine — Postgres 11+ and MySQL 8.0.12+ both have
     * fast defaults. It only turns false for unsupported adapters, which is why
     * the addColumnDefault check narrows to the volatile-uuid case.
     */
    readonly addColumnDefaultSafe: boolean
    changeTypeSafe(
        input: TypeChangeInput,
        introspect: Introspector,
    ): Promise<boolean>
    readonly rewriteBlocks: "reads and writes" | "writes"
    readonly autoIncrementingTypes: readonly string[]
    readonly maxConstraintNameLength: number
    readonly supportsConcurrentIndex: boolean
    readonly supportsNotValidConstraints: boolean

    /** Postgres 14.0-14.3 silently corrupt concurrently-built indexes. */
    hasIndexCorruptionBug(developerEnv: boolean): boolean
    /** Postgres 17+ only. */
    supportsTransactionTimeout(): boolean
    /** MySQL/MariaDB: NOT NULL is only enforced under strict mode. */
    strictMode(): Promise<boolean | undefined>
    /**
     * Lexer behaviour this session implies. Synchronous, because parsing happens in
     * the QueryRunner proxy before anything can await — see warmSessionFacts.
     */
    lexerOptions(): { ansiQuotes: boolean; noBackslashEscapes: boolean }
    /** Resolves anything the lexer needs, once, outside any transaction. */
    warmSessionFacts(): Promise<void>
}
