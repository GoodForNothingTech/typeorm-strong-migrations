import type { QueryRunner } from "typeorm"
import type { Dialect, TableRef } from "../operations/types"
import type { Adapter, Introspector, TypeChangeInput } from "./types"

export abstract class AbstractAdapter implements Adapter {
    abstract readonly key: Dialect | "unsupported"
    abstract readonly name: string
    abstract readonly dialect: Dialect
    readonly minVersion?: string
    readonly supported: boolean = true

    protected serverVersion: string | undefined

    constructor(protected readonly queryRunner: QueryRunner) {}

    version(): string | undefined {
        return this.serverVersion
    }

    setVersion(version: string | undefined): void {
        this.serverVersion = version
    }

    protected async exec(sql: string): Promise<void> {
        await this.queryRunner.query(sql)
    }

    protected async rows(sql: string): Promise<any[]> {
        const result = await this.queryRunner.query(sql)
        return Array.isArray(result) ? result : []
    }

    async setStatementTimeout(_ms: number): Promise<void> {}
    async setTransactionTimeout(_ms: number): Promise<void> {}
    async setLockTimeout(_ms: number): Promise<void> {}
    async lockTimeoutWarnings(_limitMs: number): Promise<string[]> {
        return []
    }
    async analyzeTable(_table: TableRef): Promise<void> {}

    readonly addColumnDefaultSafe: boolean = false
    readonly rewriteBlocks: "reads and writes" | "writes" = "reads and writes"
    readonly autoIncrementingTypes: readonly string[] = []
    readonly maxConstraintNameLength: number = 63
    readonly supportsConcurrentIndex: boolean = false
    readonly supportsNotValidConstraints: boolean = false

    async changeTypeSafe(
        _input: TypeChangeInput,
        _introspect: Introspector,
    ): Promise<boolean> {
        return false
    }

    hasIndexCorruptionBug(_developerEnv: boolean): boolean {
        return false
    }

    supportsTransactionTimeout(): boolean {
        return false
    }

    async strictMode(): Promise<boolean | undefined> {
        return undefined
    }

    /** Postgres has no equivalent knobs, so the defaults are always right there. */
    lexerOptions(): { ansiQuotes: boolean; noBackslashEscapes: boolean } {
        return { ansiQuotes: false, noBackslashEscapes: false }
    }

    /** Facts resolved once, before any migration transaction exists. */
    async warmSessionFacts(): Promise<void> {}
}
