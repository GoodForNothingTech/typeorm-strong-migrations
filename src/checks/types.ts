import type { DataSource, QueryRunner } from "typeorm"
import type { Adapter, Introspector } from "../adapters/types"
import type { ResolvedConfig } from "../config"
import type { RenderContext } from "../messages/commands"
import type {
    Dialect,
    Operation,
    OperationKind,
    TableRef,
} from "../operations/types"
import type { CheckKey } from "./keys"

export interface MigrationMeta {
    name: string
    /** 13-digit ms epoch parsed from the class-name suffix; absent if malformed. */
    timestamp?: number
    /** The migration's own `transaction` property, as declared. */
    declaredTransaction?: boolean
    /** `safetyAssured = true`, or a list of keys it covers. */
    instanceSafetyAssured?: boolean | readonly string[]
}

export type TransactionMode = "all" | "each" | "none"

export interface CheckContext {
    readonly dataSource: DataSource
    readonly config: ResolvedConfig
    readonly adapter: Adapter
    readonly dialect: Dialect
    readonly direction: "up" | "down"
    readonly migration: MigrationMeta
    /** The unwrapped runner. Introspection must not re-enter our own interception. */
    readonly queryRunner: QueryRunner
    readonly transactionMode: TransactionMode
    /** True when `transactionMode` was inferred rather than observed. */
    readonly transactionModeInferred: boolean
    readonly inTransaction: boolean
    readonly introspect: Introspector
    /** False in the synchronous logger layer, where awaiting is not possible. */
    readonly canIntrospect: boolean
    readonly render: RenderContext

    /** Created earlier in this same migration, so locking it harms nobody. */
    isNewTable(table: TableRef): boolean
    isNewColumn(table: TableRef, column: string): boolean
    enabled(key: CheckKey): boolean
    /** Entity class name mapped to this table, when TypeORM metadata knows one. */
    entityName(table: TableRef): string | undefined
    /** The entity property mapped to a column, for the dropColumn advice. */
    entityProperty(
        table: TableRef,
        column: string,
    ): { entity: string; property: string } | undefined
}

export type CheckVerdict =
    | { type: "ok" }
    | {
          type: "unsafe"
          key: CheckKey
          header?: string
          vars?: Record<string, string>
      }
    | { type: "warn"; message: string }
    /** safeByDefault: run this instead of the original operation. */
    | {
          type: "rewrite"
          describe: string
          run: (queryRunner: QueryRunner) => Promise<void>
      }

export interface Check {
    /** Keys this check can raise, used to resolve enable/disable. */
    readonly keys: readonly CheckKey[]
    /** Operation kinds it subscribes to. */
    readonly kinds: readonly OperationKind[]
    /** Skipped in the synchronous logger layer, which cannot await. */
    readonly needsIntrospection?: boolean
    run(
        op: Operation,
        ctx: CheckContext,
    ): CheckVerdict[] | Promise<CheckVerdict[]>
}

export const OK: CheckVerdict[] = []

export function unsafe(
    key: CheckKey,
    vars: Record<string, string> = {},
    header?: string,
): CheckVerdict {
    return header
        ? { type: "unsafe", key, vars, header }
        : { type: "unsafe", key, vars }
}

export function warn(message: string): CheckVerdict {
    return { type: "warn", message }
}
