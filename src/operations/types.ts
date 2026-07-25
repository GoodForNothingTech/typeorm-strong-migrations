/**
 * The single vocabulary every check speaks.
 *
 * Two producers feed it: `from-typed` (a wrapped QueryRunner DDL call) and
 * `from-sql` (the raw-SQL analyzer). They must produce identical objects apart
 * from `source` and `raw`, because `migration:generate` emits only raw SQL while
 * hand-written migrations use the typed API, and a check must not care which.
 */

export type Dialect = "postgres" | "mysql" | "mariadb"

export interface TableRef {
    schema?: string
    name: string
    /** Lower-cased comparison key. Unqualified names match any schema — see `sameTable`. */
    key: string
}

export function tableRef(name: string, schema?: string): TableRef {
    return {
        schema,
        name,
        key: schema
            ? `${schema.toLowerCase()}.${name.toLowerCase()}`
            : name.toLowerCase(),
    }
}

/**
 * We do not resolve `search_path`, so an unqualified reference is treated as
 * matching a qualified one with the same table name. That trades a rare
 * false negative (same table name in two schemas) for avoiding a common
 * false positive.
 */
export function sameTable(a: TableRef, b: TableRef): boolean {
    if (a.schema && b.schema) return a.key === b.key
    return a.name.toLowerCase() === b.name.toLowerCase()
}

export interface SqlType {
    /** Canonical, lower-case, alias-resolved, no parameters: "character varying". */
    baseType: string
    /** Exactly as written, parameters included: "varchar(255)". */
    raw: string
    /** The identifier before alias resolution: "varchar". */
    writtenType: string
    length?: number
    precision?: number
    scale?: number
    isArray: boolean
    withTimeZone?: boolean
    unsigned?: boolean
    /** A quoted or schema-qualified user type, e.g. "public"."status_enum". */
    isUserDefined: boolean
    enumValues?: string[]
}

export type DefaultKind =
    | "null"
    /** 3, 'abc', TRUE, DATE '2020-01-01' */
    | "literal"
    /** CURRENT_TIMESTAMP and friends — no call parentheses */
    | "keyword"
    /** now(), gen_random_uuid(), concat('a','b') */
    | "functionCall"
    /** nextval(...) — separated out because it signals a serial column */
    | "sequence"
    /** MySQL `DEFAULT (expr)`, or anything compound */
    | "expression"
    /** A JavaScript function passed as TableColumn.default */
    | "callable"

export interface DefaultValue {
    kind: DefaultKind
    /** Source text of the default expression. */
    raw: string
    /** Bare function name, lower-cased, for `functionCall` / `sequence`. */
    functionName?: string
    functionSchema?: string
    /**
     * Whether the expression contains a call. The gem tests `default.include?("()")`;
     * checking for a call shape is the same intent without matching a string literal
     * that happens to contain parentheses.
     */
    containsCall: boolean
    literal?: string | number | boolean | null
}

export interface ColumnSpec {
    name: string
    type?: SqlType
    /** `undefined` means the statement did not say. */
    nullable?: boolean
    default?: DefaultValue
    autoIncrement?: {
        style: "serial" | "identity" | "autoIncrement"
        identityMode?: "ALWAYS" | "BY DEFAULT"
    }
    generated?: { expression: string; storage: "STORED" | "VIRTUAL" }
    isPrimaryKey?: boolean
    isUnique?: boolean
    comment?: string
    onUpdate?: string
    /** Source text of the whole column definition, for message rendering. */
    raw?: string
    /**
     * Clauses in the definition the parser skipped. Propagated to the operation as
     * `partial`, so nothing rebuilds a column definition it only partly read.
     */
    unmodeled?: string[]
}

export interface IndexColumn {
    name?: string
    /** Raw text for a functional index, e.g. `lower(email)`. */
    expression?: string
    direction?: "ASC" | "DESC"
    length?: number
}

export interface MysqlAlterOptions {
    algorithm?: "DEFAULT" | "INPLACE" | "COPY" | "INSTANT" | "NOCOPY"
    lock?: "DEFAULT" | "NONE" | "SHARED" | "EXCLUSIVE"
}

export interface SourceSpan {
    /** Index of the statement within one `query()` call. */
    statementIndex: number
    start: number
    end: number
    sql: string
}

export interface OperationBase {
    source: "typed" | "sql"
    /** How this reached us — the typed method name and args, or the raw SQL. */
    raw: { method?: string; args?: readonly unknown[]; sql?: string }
    span?: SourceSpan
    /** The head matched but a tail clause was not modeled. Checks must degrade. */
    partial?: boolean
    /** Clauses recognized as present but not interpreted. */
    unmodeledClauses?: string[]
    /** Per-statement marker comments, e.g. `-- strong-migrations:ignore`. */
    markers?: { safetyAssured?: boolean; disabled?: string[] }
}

export type Operation =
    | (OperationBase & {
          kind: "createTable"
          table: TableRef
          columns: ColumnSpec[]
          ifNotExists?: boolean
      })
    | (OperationBase & {
          kind: "dropTable"
          tables: TableRef[]
          ifExists?: boolean
          cascade?: boolean
      })
    | (OperationBase & {
          kind: "renameTable"
          table: TableRef
          newName: string
      })
    | (OperationBase & {
          kind: "truncate"
          tables: TableRef[]
          cascade?: boolean
      })
    | (OperationBase & {
          kind: "addColumn"
          table: TableRef
          column: ColumnSpec
          mysql?: MysqlAlterOptions
      })
    | (OperationBase & {
          kind: "dropColumn"
          table: TableRef
          columns: string[]
          mysql?: MysqlAlterOptions
      })
    | (OperationBase & {
          kind: "renameColumn"
          table: TableRef
          from: string
          to: string
      })
    | (OperationBase & {
          kind: "changeColumn"
          table: TableRef
          column: string
          newType?: SqlType
          /** Set when the same clause also changes nullability (MySQL CHANGE/MODIFY). */
          setNullable?: boolean
          newDefault?: DefaultValue
          using?: string
          mysql?: MysqlAlterOptions
      })
    | (OperationBase & {
          kind: "changeColumnDefault"
          table: TableRef
          column: string
          /** Absent means DROP DEFAULT. */
          newDefault?: DefaultValue
      })
    | (OperationBase & {
          kind: "changeColumnNull"
          table: TableRef
          column: string
          /** false => SET NOT NULL, true => DROP NOT NULL */
          nullable: boolean
      })
    | (OperationBase & {
          kind: "createIndex"
          table: TableRef
          name?: string
          columns: IndexColumn[]
          unique: boolean
          concurrent: boolean
          where?: string
          using?: string
          /** PG covering index: INCLUDE (a, b). Dropping it changes the index. */
          include?: string[]
          /** PG 15+; changes what "unique" means for NULLs. */
          nullsNotDistinct?: boolean
          fulltext?: boolean
          spatial?: boolean
          viaAlterTable?: boolean
          mysql?: MysqlAlterOptions
      })
    | (OperationBase & {
          kind: "dropIndex"
          /** Postgres `DROP INDEX x` carries no table. */
          table?: TableRef
          name: string
          concurrent: boolean
          viaAlterTable?: boolean
          mysql?: MysqlAlterOptions
      })
    | (OperationBase & {
          kind: "createForeignKey"
          table: TableRef
          name?: string
          columns: string[]
          referencedTable: TableRef
          referencedColumns: string[]
          notValid: boolean
          mysql?: MysqlAlterOptions
      })
    | (OperationBase & {
          kind: "dropForeignKey"
          table: TableRef
          name: string
      })
    | (OperationBase & {
          kind: "createCheckConstraint"
          table: TableRef
          name?: string
          expression: string
          notValid: boolean
      })
    | (OperationBase & {
          kind: "createUniqueConstraint"
          table: TableRef
          name?: string
          columns: string[]
          /** The safe form: ADD CONSTRAINT ... UNIQUE USING INDEX ... */
          usingIndex?: string
      })
    | (OperationBase & {
          kind: "createExclusionConstraint"
          table: TableRef
          name?: string
          expression: string
      })
    | (OperationBase & {
          kind: "createPrimaryKey"
          table: TableRef
          name?: string
          columns: string[]
          usingIndex?: string
      })
    | (OperationBase & {
          kind: "dropConstraint"
          table: TableRef
          name: string
      })
    /**
     * `ALTER TABLE t VALIDATE CONSTRAINT c`. SQL alone cannot say whether the
     * constraint is a check or a foreign key; the check introspects `pg_constraint`
     * to pick the right message and falls back to the generic one.
     */
    | (OperationBase & {
          kind: "validateConstraint"
          table: TableRef
          name: string
      })
    | (OperationBase & {
          kind: "renameEnumValue"
          type: TableRef
          from: string
          to: string
      })
    | (OperationBase & {
          kind: "addEnumValue"
          type: TableRef
          value: string
          before?: string
          after?: string
      })
    | (OperationBase & { kind: "renameSchema"; from: string; to: string })
    /** UPDATE/DELETE that touches every row. */
    | (OperationBase & {
          kind: "backfill"
          verb: "UPDATE" | "DELETE"
          tables: TableRef[]
          sql: string
      })
    | (OperationBase & {
          kind: "dropView"
          views: TableRef[]
          materialized?: boolean
          ifExists?: boolean
          cascade?: boolean
      })
    | (OperationBase & {
          kind: "dropSchema"
          schema: string
          cascade?: boolean
      })
    | (OperationBase & { kind: "dropDatabase"; database: string })
    /** `queryRunner.clearDatabase()` — drops every table and view. */
    | (OperationBase & { kind: "clearDatabase"; database?: string })
    /**
     * An operation that rebuilds the whole table in place: MySQL `ENGINE=`, `FORCE`,
     * `CONVERT TO CHARACTER SET`, `ROW_FORMAT=`, `ORDER BY`; Postgres `SET LOGGED`,
     * `SET TABLESPACE`.
     */
    | (OperationBase & {
          kind: "tableRewrite"
          table: TableRef
          /** The clause that causes it, for the message. */
          clause: string
      })
    | (OperationBase & { kind: "vacuumFull"; tables: TableRef[] })
    | (OperationBase & {
          kind: "disableTrigger"
          table: TableRef
          trigger: string
      })
    /** MySQL `FLUSH TABLES WITH READ LOCK` — a global read lock. */
    | (OperationBase & { kind: "flushTables"; withReadLock: boolean })
    /** `INSERT … SELECT` with no bound: the write-everything sibling of `backfill`. */
    | (OperationBase & {
          kind: "insertSelect"
          tables: TableRef[]
          sql: string
      })
    /** Recognized, carries no risk, and no check subscribes: SELECT, SET, COMMIT, ... */
    | (OperationBase & { kind: "benign"; sql: string })
    | (OperationBase & {
          kind: "unknown"
          sql: string
          reason:
              | "lex-error"
              | "unrecognized-head"
              | "unsupported-shape"
              | "procedural-block"
          /** First few keywords, used for the message and the DDL-shape heuristic. */
          head: string
          looksLikeDdl: boolean
          probableTable?: TableRef
      })

export type OperationKind = Operation["kind"]

/** Tables an operation reads or writes — used for bookkeeping suppression. */
export function operationTables(op: Operation): TableRef[] {
    switch (op.kind) {
        case "dropTable":
        case "truncate":
        case "backfill":
        case "vacuumFull":
        case "insertSelect":
            return op.tables
        case "dropView":
            return op.views
        case "tableRewrite":
        case "disableTrigger":
            return [op.table]
        case "createTable":
        case "renameTable":
        case "addColumn":
        case "dropColumn":
        case "renameColumn":
        case "changeColumn":
        case "changeColumnDefault":
        case "changeColumnNull":
        case "createIndex":
        case "createCheckConstraint":
        case "createUniqueConstraint":
        case "createExclusionConstraint":
        case "createPrimaryKey":
        case "dropConstraint":
        case "validateConstraint":
        case "dropForeignKey":
            return [op.table]
        case "createForeignKey":
            return [op.table, op.referencedTable]
        case "dropIndex":
            return op.table ? [op.table] : []
        case "renameEnumValue":
        case "addEnumValue":
            return [op.type]
        default:
            return []
    }
}
