import type {
    Dialect,
    IndexColumn,
    MysqlAlterOptions,
    Operation,
    OperationBase,
    SourceSpan,
    TableRef,
} from "../operations/types"
import { tableRef } from "../operations/types"
import { parseColumnDef, readTypeText } from "./columns"
import { TokenCursor } from "./cursor"
import { readDefault } from "./defaults"
import type { RawStatement } from "./lexer"
import { parseSqlType } from "./types"

/**
 * Statement-shape matchers over the token stream.
 *
 * Every parser here follows the same contract: match the head, model what it
 * understands, and capture anything else as raw text with `partial: true`. It never
 * throws — a linter that dies on unfamiliar SQL is worse than one that admits it
 * does not know.
 */

interface Ctx {
    dialect: Dialect
    statement: RawStatement
    statementIndex: number
}

function span(ctx: Ctx): SourceSpan {
    return {
        statementIndex: ctx.statementIndex,
        start: ctx.statement.start,
        end: ctx.statement.end,
        sql: ctx.statement.sql,
    }
}

function meta(ctx: Ctx): OperationBase {
    return { source: "sql", raw: { sql: ctx.statement.sql }, span: span(ctx) }
}

function unknown(
    ctx: Ctx,
    reason:
        | "lex-error"
        | "unrecognized-head"
        | "unsupported-shape"
        | "procedural-block",
    head: string[],
    probableTable?: TableRef,
): Operation {
    return {
        ...meta(ctx),
        kind: "unknown",
        sql: ctx.statement.sql,
        reason,
        head: head.join(" "),
        // A lex error means we could not even tokenize, so we cannot claim the
        // statement is harmless. Treating it as probable DDL is what routes it
        // through the `unknownSql` policy instead of silently ignoring it.
        looksLikeDdl: reason === "lex-error" || DDL_HEADS.has(head[0] ?? ""),
        probableTable,
    }
}

function benign(ctx: Ctx): Operation {
    return { ...meta(ctx), kind: "benign", sql: ctx.statement.sql }
}

export const DDL_HEADS = new Set([
    "alter",
    "create",
    "drop",
    "rename",
    "truncate",
    "comment",
    "reindex",
    "cluster",
    "lock",
    "refresh",
    "do",
    "call",
    "grant",
    "revoke",
    "optimize",
    "repair",
])

const BENIGN_HEADS = new Set([
    "select",
    "with",
    "show",
    "explain",
    "describe",
    "desc",
    "set",
    "reset",
    "analyze",
    "begin",
    "start",
    "commit",
    "rollback",
    "savepoint",
    "release",
    "use",
    "prepare",
    "deallocate",
    "discard",
    "checkpoint",
    "grant",
    "revoke",
])

/** Statement heads whose body we deliberately refuse to interpret. */
const PROCEDURAL = new Set([
    "function",
    "procedure",
    "trigger",
    "rule",
    "policy",
])

function toTable(
    name: { schema?: string; name: string } | undefined,
): TableRef {
    if (!name) return tableRef("?")
    return name.schema ? tableRef(name.name, name.schema) : tableRef(name.name)
}

export function parseStatement(
    statement: RawStatement,
    statementIndex: number,
    dialect: Dialect,
): Operation[] {
    const ctx: Ctx = { dialect, statement, statementIndex }
    if (statement.lexError) return [unknown(ctx, "lex-error", ["?"])]

    const cursor = new TokenCursor(statement)
    const head = cursor.peekWords(3)
    switch (head[0]) {
        case "alter":
            return parseAlter(cursor, ctx)
        case "create":
            return parseCreate(cursor, ctx)
        case "drop":
            return parseDrop(cursor, ctx)
        case "rename":
            return parseRenameTable(cursor, ctx)
        case "truncate":
            return parseTruncate(cursor, ctx)
        case "comment":
            return [benign(ctx)]
        case "update":
        case "delete":
            return parseDml(
                cursor,
                ctx,
                head[0] === "update" ? "UPDATE" : "DELETE",
            )
        case "do":
            return [unknown(ctx, "procedural-block", head)]
        // These three heads are usually harmless but have a dangerous form, so they
        // are matched on shape rather than on the head alone.
        case "vacuum":
            return parseVacuum(cursor, ctx)
        case "flush":
            return parseFlush(cursor, ctx)
        case "insert":
        case "replace":
            return parseInsert(cursor, ctx)
        default:
            if (head[0] && BENIGN_HEADS.has(head[0])) return [benign(ctx)]
            return [unknown(ctx, "unrecognized-head", head)]
    }
}

/** `VACUUM` is routine; `VACUUM FULL` rewrites the table under ACCESS EXCLUSIVE. */
function parseVacuum(cursor: TokenCursor, ctx: Ctx): Operation[] {
    const base = meta(ctx)
    cursor.eatKeyword("vacuum")

    let full = false
    // Both `VACUUM FULL t` and `VACUUM (FULL, ANALYZE) t` are legal.
    if (cursor.isPunct("(")) {
        const options = cursor.eatParenGroup() ?? ""
        full = /\bfull\b/i.test(options)
    } else {
        while (
            cursor.eatKeyword("full") ||
            cursor.eatKeyword("freeze") ||
            cursor.eatKeyword("analyze")
        ) {
            if (cursor.tokens[cursor.pos - 1]?.lower === "full") full = true
        }
    }
    if (!full) return [benign(ctx)]

    const tables: TableRef[] = []
    do {
        const name = cursor.eatQualifiedName()
        if (name) tables.push(toTable(name))
    } while (cursor.eatPunct(","))
    return [{ ...base, kind: "vacuumFull", tables }]
}

/** `FLUSH PRIVILEGES` is harmless; `FLUSH TABLES WITH READ LOCK` locks the server. */
function parseFlush(cursor: TokenCursor, ctx: Ctx): Operation[] {
    const base = meta(ctx)
    const withReadLock = cursor.tokens.some(
        (token, index) =>
            token.lower === "read" &&
            cursor.tokens[index + 1]?.lower === "lock",
    )
    if (!withReadLock) return [benign(ctx)]
    return [{ ...base, kind: "flushTables", withReadLock: true }]
}

/**
 * `INSERT INTO t VALUES (...)` is bounded; `INSERT INTO t SELECT ...` writes as many
 * rows as the select returns. That is the same unbounded-write hazard `backfill`
 * catches for UPDATE and DELETE.
 */
function parseInsert(cursor: TokenCursor, ctx: Ctx): Operation[] {
    const base = meta(ctx)
    cursor.pos += 1
    cursor.eatKeyword("into")
    cursor.eatKeyword("ignore")
    const table = cursor.eatQualifiedName()

    const fromSelect = cursor.tokens.some(
        (token) => token.kind === "word" && token.lower === "select",
    )
    if (!fromSelect) return [benign(ctx)]

    return [
        {
            ...base,
            kind: "insertSelect",
            tables: table ? [toTable(table)] : [],
            sql: ctx.statement.sql,
        },
    ]
}

// ── ALTER ────────────────────────────────────────────────────────────────────

function parseAlter(cursor: TokenCursor, ctx: Ctx): Operation[] {
    cursor.eatKeyword("alter")

    if (cursor.eatKeyword("table")) return parseAlterTable(cursor, ctx)
    if (cursor.eatKeyword("type")) return parseAlterType(cursor, ctx)
    if (cursor.eatKeyword("schema")) return parseAlterSchema(cursor, ctx)
    if (cursor.eatKeyword("index")) return [benign(ctx)]
    if (cursor.eatKeyword("sequence")) return [benign(ctx)]
    // ALTER FUNCTION / PROCEDURE / VIEW and friends.
    return [
        unknown(ctx, "unsupported-shape", [
            "alter",
            cursor.peek()?.lower ?? "?",
        ]),
    ]
}

function parseAlterTable(cursor: TokenCursor, ctx: Ctx): Operation[] {
    cursor.eatSequence("if", "exists")
    cursor.eatKeyword("only")
    const table = toTable(cursor.eatQualifiedName())

    const operations: Operation[] = []
    let mysqlOptions: MysqlAlterOptions | undefined

    do {
        // ALGORITHM=/LOCK= are table-level options, not actions, and may appear
        // anywhere in the comma list.
        const option = readMysqlAlterOption(cursor)
        if (option) {
            mysqlOptions = { ...mysqlOptions, ...option }
            continue
        }
        const produced = parseAlterAction(cursor, ctx, table)
        if (produced.length === 0) {
            // Unmodeled action: record it and keep the operations already parsed, so
            // `ALTER TABLE t ADD c int, SET (fillfactor=90)` still yields the addColumn.
            const text = cursor.takeUntilTopLevelComma()
            for (const op of operations) {
                op.partial = true
                if (text) {
                    op.unmodeledClauses = [...(op.unmodeledClauses ?? []), text]
                }
            }
            if (operations.length === 0) {
                // Unconditional, even when `text` is empty. A malformed action that
                // consumed its last token — `ALTER TABLE t DROP COLUMN` — used to
                // produce no operations at all, and zero operations makes the checker
                // execute the statement completely unchecked.
                operations.push(
                    unknown(
                        ctx,
                        "unsupported-shape",
                        ["alter", "table"],
                        table,
                    ),
                )
            }
        } else operations.push(...produced)
    } while (cursor.eatPunct(","))

    if (mysqlOptions) {
        // ALGORITHM/LOCK are statement-level, so they apply to every action in the
        // comma list. The property is absent until assigned, so this cannot be
        // gated on `"mysql" in op`.
        for (const op of operations) {
            if (MYSQL_OPTION_KINDS.has(op.kind)) {
                ;(op as { mysql?: MysqlAlterOptions }).mysql = mysqlOptions
            }
        }
    }
    return operations
}

const MYSQL_OPTION_KINDS = new Set([
    "addColumn",
    "dropColumn",
    "changeColumn",
    "createIndex",
    "dropIndex",
    "createForeignKey",
])

/**
 * Table options that are metadata-only. Consumed so the statement is not written off
 * as uninterpretable, and then ignored.
 */
const HARMLESS_TABLE_OPTIONS = new Set([
    "comment",
    "auto_increment",
    "avg_row_length",
    "delay_key_write",
    "insert_method",
    "max_rows",
    "min_rows",
    "stats_persistent",
    "collate",
    "character",
    "charset",
    "default",
])

/**
 * Table options that rebuild the entire table.
 *
 * These were previously lumped in with the harmless ones and classified `benign`,
 * which meant `from-sql` discarded them before any check ran — so
 * `ALTER TABLE t ENGINE=InnoDB`, the canonical "defragment in a migration" outage,
 * was invisible. The hazard is the rewrite and the lock, not the shape change, which
 * is why "changes no schema we model" was the wrong test.
 */
const REWRITING_TABLE_OPTIONS = new Set([
    "engine",
    "force",
    "convert",
    "row_format",
    "key_block_size",
    "pack_keys",
    "order",
    "checksum",
    "tablespace",
    "discard",
    "import",
])

function readMysqlAlterOption(
    cursor: TokenCursor,
): MysqlAlterOptions | undefined {
    for (const keyword of ["algorithm", "lock"] as const) {
        if (!cursor.isKeyword(keyword)) continue
        const saved = cursor.pos
        cursor.pos += 1
        // Both `ALGORITHM=COPY` and `ALGORITHM COPY` are accepted by MySQL.
        const token = cursor.peek()
        if (token?.kind === "operator" && token.value === "=") cursor.pos += 1
        const value = cursor.eatIdent()
        if (!value) {
            cursor.pos = saved
            return undefined
        }
        const upper = value.toUpperCase()
        return keyword === "algorithm"
            ? { algorithm: upper as MysqlAlterOptions["algorithm"] }
            : { lock: upper as MysqlAlterOptions["lock"] }
    }
    return undefined
}

function parseAlterAction(
    cursor: TokenCursor,
    ctx: Ctx,
    table: TableRef,
): Operation[] {
    const base = meta(ctx)

    const head = cursor.peek()
    if (head?.kind === "word" && HARMLESS_TABLE_OPTIONS.has(head.lower)) {
        cursor.skipToTopLevelComma()
        return [benign(ctx)]
    }
    if (head?.kind === "word" && REWRITING_TABLE_OPTIONS.has(head.lower)) {
        const start = cursor.pos
        cursor.skipToTopLevelComma()
        return [
            {
                ...base,
                kind: "tableRewrite",
                table,
                clause: cursor.rawFrom(start),
            },
        ]
    }
    // Postgres: DISABLE/ENABLE TRIGGER turns off constraint enforcement — the classic
    // "switch off foreign keys for a backfill" footgun. Previously benign, because
    // `disable` sat in the table-options set.
    if (cursor.isKeyword("disable") || cursor.isKeyword("enable")) {
        const enabling = cursor.isKeyword("enable")
        const saved = cursor.pos
        cursor.pos += 1
        cursor.eatKeyword("always")
        cursor.eatKeyword("replica")
        if (cursor.eatKeyword("trigger")) {
            const trigger = cursor.eatIdent() ?? "ALL"
            // Re-enabling is the safe half of the pair; only the disable is a hazard.
            if (enabling) return [benign(ctx)]
            return [{ ...base, kind: "disableTrigger", table, trigger }]
        }
        cursor.pos = saved
        cursor.skipToTopLevelComma()
        return [benign(ctx)]
    }
    // Postgres rewrites expressed as SET: SET LOGGED/UNLOGGED and SET TABLESPACE.
    if (cursor.isKeyword("set")) {
        const saved = cursor.pos
        cursor.pos += 1
        const what = cursor.peek()?.lower
        if (what === "logged" || what === "unlogged" || what === "tablespace") {
            cursor.pos = saved
            const start = cursor.pos
            cursor.skipToTopLevelComma()
            return [
                {
                    ...base,
                    kind: "tableRewrite",
                    table,
                    clause: cursor.rawFrom(start),
                },
            ]
        }
        cursor.pos = saved
    }

    if (cursor.eatKeyword("add")) return parseAddAction(cursor, ctx, table)

    if (cursor.eatKeyword("drop")) {
        if (cursor.eatKeyword("column")) {
            cursor.eatSequence("if", "exists")
            const name = cursor.eatIdent()
            cursor.eatKeyword("cascade")
            return name
                ? [{ ...base, kind: "dropColumn", table, columns: [name] }]
                : []
        }
        if (cursor.eatKeyword("constraint")) {
            cursor.eatSequence("if", "exists")
            const name = cursor.eatIdent()
            cursor.eatKeyword("cascade")
            return name
                ? [{ ...base, kind: "dropConstraint", table, name }]
                : []
        }
        if (cursor.eatSequence("foreign", "key")) {
            const name = cursor.eatIdent()
            return name
                ? [{ ...base, kind: "dropForeignKey", table, name }]
                : []
        }
        if (cursor.eatKeyword("index") || cursor.eatKeyword("key")) {
            const name = cursor.eatIdent()
            return name
                ? [
                      {
                          ...base,
                          kind: "dropIndex",
                          table,
                          name,
                          concurrent: false,
                          viaAlterTable: true,
                      },
                  ]
                : []
        }
        if (cursor.eatSequence("primary", "key")) {
            return [{ ...base, kind: "dropConstraint", table, name: "PRIMARY" }]
        }
        // Postgres allows the COLUMN keyword to be omitted.
        const name = cursor.eatIdent()
        return name
            ? [{ ...base, kind: "dropColumn", table, columns: [name] }]
            : []
    }

    if (cursor.eatKeyword("validate")) {
        if (!cursor.eatKeyword("constraint")) return []
        const name = cursor.eatIdent()
        return name
            ? [{ ...base, kind: "validateConstraint", table, name }]
            : []
    }

    if (cursor.eatKeyword("rename")) {
        if (cursor.eatKeyword("to")) {
            const name = cursor.eatIdent()
            return name
                ? [{ ...base, kind: "renameTable", table, newName: name }]
                : []
        }
        if (cursor.eatKeyword("constraint")) {
            cursor.eatIdent()
            cursor.eatKeyword("to")
            cursor.eatIdent()
            return [benign(ctx)]
        }
        cursor.eatKeyword("column")
        const from = cursor.eatIdent()
        cursor.eatKeyword("to")
        const to = cursor.eatIdent()
        return from && to
            ? [{ ...base, kind: "renameColumn", table, from, to }]
            : []
    }

    if (cursor.eatKeyword("alter")) {
        cursor.eatKeyword("column")
        const column = cursor.eatIdent()
        if (!column) return []
        return parseAlterColumnAction(cursor, ctx, table, column)
    }

    // MySQL's CHANGE and MODIFY rebuild the whole column definition.
    if (cursor.eatKeyword("change")) {
        cursor.eatKeyword("column")
        const oldName = cursor.eatIdent()
        if (!oldName) return []
        const definition = parseColumnDef(cursor, ctx.dialect)
        if (!definition) return []
        const operations: Operation[] = []
        if (definition.name.toLowerCase() !== oldName.toLowerCase()) {
            operations.push({
                ...base,
                kind: "renameColumn",
                table,
                from: oldName,
                to: definition.name,
            })
        }
        operations.push({
            ...base,
            kind: "changeColumn",
            table,
            column: oldName,
            newType: definition.type,
            setNullable: definition.nullable,
            newDefault: definition.default,
        })
        return operations
    }

    if (cursor.eatKeyword("modify")) {
        cursor.eatKeyword("column")
        const definition = parseColumnDef(cursor, ctx.dialect)
        if (!definition) return []
        return [
            {
                ...base,
                kind: "changeColumn",
                table,
                column: definition.name,
                newType: definition.type,
                setNullable: definition.nullable,
                newDefault: definition.default,
            },
        ]
    }

    return []
}

function parseAlterColumnAction(
    cursor: TokenCursor,
    ctx: Ctx,
    table: TableRef,
    column: string,
): Operation[] {
    const base = meta(ctx)

    if (
        cursor.eatKeyword("type") ||
        cursor.eatSequence("set", "data", "type")
    ) {
        const typeText = readTypeText(cursor)
        let using: string | undefined
        if (cursor.eatKeyword("using")) using = cursor.takeUntilTopLevelComma()
        // A collation change rewrites the column and invalidates every index on it,
        // and we do not model it — so record it rather than discarding it.
        let collate: string | undefined
        if (cursor.eatKeyword("collate")) {
            collate = cursor.eatQualifiedName()?.name
        }
        return [
            {
                ...base,
                kind: "changeColumn",
                table,
                column,
                newType: typeText
                    ? parseSqlType(typeText, ctx.dialect)
                    : undefined,
                using,
                partial: collate ? true : undefined,
                unmodeledClauses: collate ? [`COLLATE ${collate}`] : undefined,
            },
        ]
    }

    if (cursor.eatSequence("set", "not", "null")) {
        return [
            {
                ...base,
                kind: "changeColumnNull",
                table,
                column,
                nullable: false,
            },
        ]
    }
    if (cursor.eatSequence("drop", "not", "null")) {
        return [
            {
                ...base,
                kind: "changeColumnNull",
                table,
                column,
                nullable: true,
            },
        ]
    }
    if (cursor.eatSequence("set", "default")) {
        return [
            {
                ...base,
                kind: "changeColumnDefault",
                table,
                column,
                newDefault: readDefault(cursor),
            },
        ]
    }
    if (cursor.eatSequence("drop", "default")) {
        return [{ ...base, kind: "changeColumnDefault", table, column }]
    }
    return []
}

function parseAddAction(
    cursor: TokenCursor,
    ctx: Ctx,
    table: TableRef,
): Operation[] {
    const base = meta(ctx)

    let constraintName: string | undefined
    if (cursor.eatKeyword("constraint")) constraintName = cursor.eatIdent()

    if (cursor.eatSequence("foreign", "key")) {
        const columns = readNameList(cursor)
        cursor.eatKeyword("references")
        const referenced = toTable(cursor.eatQualifiedName())
        const referencedColumns = readNameList(cursor)
        const tail = readConstraintTail(cursor)
        return [
            {
                ...base,
                kind: "createForeignKey",
                table,
                name: constraintName,
                columns,
                referencedTable: referenced,
                referencedColumns,
                notValid: tail.notValid,
                partial: tail.unmodeled.length > 0 || undefined,
                unmodeledClauses: tail.unmodeled.length
                    ? tail.unmodeled
                    : undefined,
            },
        ]
    }

    if (cursor.eatKeyword("check")) {
        const expression = cursor.eatParenGroup() ?? ""
        const tail = readConstraintTail(cursor)
        return [
            {
                ...base,
                kind: "createCheckConstraint",
                table,
                name: constraintName,
                expression,
                notValid: tail.notValid,
                partial: tail.unmodeled.length > 0 || undefined,
                unmodeledClauses: tail.unmodeled.length
                    ? tail.unmodeled
                    : undefined,
            },
        ]
    }

    if (cursor.eatKeyword("exclude")) {
        const start = cursor.pos
        cursor.skipToTopLevelComma()
        return [
            {
                ...base,
                kind: "createExclusionConstraint",
                table,
                name: constraintName,
                expression: cursor.rawFrom(start),
            },
        ]
    }

    if (cursor.eatSequence("primary", "key")) {
        const columns = readNameList(cursor)
        let usingIndex: string | undefined
        if (cursor.eatSequence("using", "index")) usingIndex = cursor.eatIdent()
        const pkTail = readConstraintTail(cursor)
        return [
            {
                ...base,
                partial: pkTail.unmodeled.length > 0 || undefined,
                unmodeledClauses: pkTail.unmodeled.length
                    ? pkTail.unmodeled
                    : undefined,
                kind: "createPrimaryKey",
                table,
                name: constraintName,
                columns,
                usingIndex,
            },
        ]
    }

    if (cursor.isKeyword("unique")) {
        cursor.eatKeyword("unique")
        // MySQL spells the index form `ADD UNIQUE INDEX name (cols)`.
        const isIndexForm =
            cursor.eatKeyword("index") || cursor.eatKeyword("key")
        if (isIndexForm) {
            const name = cursor.isPunct("(") ? undefined : cursor.eatIdent()
            const columns = readIndexColumns(cursor)
            return [
                {
                    ...base,
                    kind: "createIndex",
                    table,
                    name: name ?? constraintName,
                    columns,
                    unique: true,
                    concurrent: false,
                    viaAlterTable: true,
                },
            ]
        }
        let usingIndex: string | undefined
        let columns: string[] = []
        if (cursor.eatSequence("using", "index")) usingIndex = cursor.eatIdent()
        else columns = readNameList(cursor)
        const uniqueTail = readConstraintTail(cursor)
        return [
            {
                ...base,
                kind: "createUniqueConstraint",
                table,
                name: constraintName,
                columns,
                usingIndex,
                partial: uniqueTail.unmodeled.length > 0 || undefined,
                unmodeledClauses: uniqueTail.unmodeled.length
                    ? uniqueTail.unmodeled
                    : undefined,
            },
        ]
    }

    if (
        cursor.isKeyword("index") ||
        cursor.isKeyword("key") ||
        cursor.isKeyword("fulltext") ||
        cursor.isKeyword("spatial")
    ) {
        const fulltext = cursor.eatKeyword("fulltext")
        const spatial = cursor.eatKeyword("spatial")
        cursor.eatKeyword("index")
        cursor.eatKeyword("key")
        const name = cursor.isPunct("(") ? undefined : cursor.eatIdent()
        const columns = readIndexColumns(cursor)
        return [
            {
                ...base,
                kind: "createIndex",
                table,
                name,
                columns,
                unique: false,
                concurrent: false,
                fulltext,
                spatial,
                viaAlterTable: true,
            },
        ]
    }

    // Plain column add. Postgres omits COLUMN; MySQL allows either.
    cursor.eatKeyword("column")
    cursor.eatSequence("if", "not", "exists")
    const column = parseColumnDef(cursor, ctx.dialect)
    if (!column) return []
    // MySQL positional clauses.
    cursor.eatKeyword("first")
    if (cursor.eatKeyword("after")) cursor.eatIdent()
    return [
        {
            ...base,
            kind: "addColumn",
            table,
            column,
            partial: column.unmodeled?.length ? true : undefined,
            unmodeledClauses: column.unmodeled?.length
                ? column.unmodeled
                : undefined,
        },
    ]
}

interface ConstraintTail {
    notValid: boolean
    /**
     * Clauses in the tail we do not model — `ON DELETE CASCADE`, `DEFERRABLE`,
     * `NO INHERIT`. Reported so a rewrite refuses: `rewriteForeignKeyNotValid`
     * reconstructs the constraint, and silently dropping `ON DELETE CASCADE` would
     * change referential behaviour.
     */
    unmodeled: string[]
}

/** Consumes the constraint tail, noting NOT VALID and anything else it contains. */
function readConstraintTail(cursor: TokenCursor): ConstraintTail {
    let depth = 0
    let notValid = false
    const unmodeled: string[] = []

    while (!cursor.done) {
        const token = cursor.peek()!
        if (
            token.kind === "punct" &&
            (token.value === "(" || token.value === "[")
        )
            depth += 1
        else if (
            token.kind === "punct" &&
            (token.value === ")" || token.value === "]")
        )
            depth -= 1
        else if (token.kind === "punct" && token.value === "," && depth === 0)
            break
        else if (depth === 0 && token.kind === "word") {
            if (token.lower === "not" && cursor.peek(1)?.lower === "valid") {
                notValid = true
                cursor.pos += 2
                continue
            }
            if (token.lower === "on" && cursor.peek(1)) {
                // ON DELETE / ON UPDATE <action>
                const action = cursor.peek(2)?.value ?? ""
                unmodeled.push(`ON ${cursor.peek(1)!.value} ${action}`.trim())
            } else if (
                token.lower === "deferrable" ||
                token.lower === "initially"
            ) {
                unmodeled.push(token.value)
            } else if (
                token.lower === "no" &&
                cursor.peek(1)?.lower === "inherit"
            ) {
                unmodeled.push("NO INHERIT")
            }
        }
        cursor.pos += 1
    }
    return { notValid, unmodeled }
}

function readNameList(cursor: TokenCursor): string[] {
    if (!cursor.isPunct("(")) return []
    const names: string[] = []
    cursor.pos += 1
    while (!cursor.done && !cursor.isPunct(")")) {
        const name = cursor.eatIdent()
        if (name !== undefined) names.push(name)
        else cursor.pos += 1
        cursor.eatPunct(",")
    }
    cursor.eatPunct(")")
    return names
}

function readIndexColumns(cursor: TokenCursor): IndexColumn[] {
    if (!cursor.isPunct("(")) return []
    const columns: IndexColumn[] = []
    cursor.pos += 1
    let depth = 1
    let itemStart = cursor.pos
    while (!cursor.done) {
        const token = cursor.peek()!
        if (token.kind === "punct" && token.value === "(") {
            depth += 1
            cursor.pos += 1
            continue
        }
        if (token.kind === "punct" && token.value === ")") {
            depth -= 1
            if (depth === 0) {
                pushIndexColumn(cursor, itemStart, columns)
                cursor.pos += 1
                break
            }
            cursor.pos += 1
            continue
        }
        if (token.kind === "punct" && token.value === "," && depth === 1) {
            pushIndexColumn(cursor, itemStart, columns)
            cursor.pos += 1
            itemStart = cursor.pos
            continue
        }
        cursor.pos += 1
    }
    return columns
}

function pushIndexColumn(
    cursor: TokenCursor,
    itemStart: number,
    columns: IndexColumn[],
): void {
    if (cursor.pos <= itemStart) return
    const tokens = cursor.tokens.slice(itemStart, cursor.pos)
    const savedPos = cursor.pos
    cursor.pos = savedPos
    const text = cursor.rawFrom(itemStart)
    if (!text) return

    // A single identifier (optionally with a sort direction) is a plain column;
    // anything else is an expression index.
    const meaningful = tokens.filter(
        (token) =>
            !(
                token.kind === "word" &&
                ["asc", "desc", "nulls", "first", "last"].includes(token.lower)
            ),
    )
    const direction = tokens.some((token) => token.lower === "desc")
        ? "DESC"
        : undefined
    if (
        meaningful.length === 1 &&
        (meaningful[0]!.kind === "ident" || meaningful[0]!.kind === "word")
    ) {
        columns.push({ name: meaningful[0]!.value, direction })
        return
    }
    // MySQL prefix index: `col(10)`
    if (
        meaningful.length === 4 &&
        (meaningful[0]!.kind === "ident" || meaningful[0]!.kind === "word") &&
        meaningful[1]!.value === "(" &&
        meaningful[2]!.kind === "number"
    ) {
        columns.push({
            name: meaningful[0]!.value,
            length: Number(meaningful[2]!.value),
        })
        return
    }
    columns.push({ expression: text, direction })
}

// ── ALTER TYPE / SCHEMA ─────────────────────────────────────────────────────

function parseAlterType(cursor: TokenCursor, ctx: Ctx): Operation[] {
    const base = meta(ctx)
    const type = toTable(cursor.eatQualifiedName())

    if (cursor.eatSequence("rename", "value")) {
        const from = cursor.eatString() ?? ""
        cursor.eatKeyword("to")
        const to = cursor.eatString() ?? ""
        return [{ ...base, kind: "renameEnumValue", type, from, to }]
    }
    if (cursor.eatSequence("add", "value")) {
        cursor.eatSequence("if", "not", "exists")
        const value = cursor.eatString() ?? ""
        let before: string | undefined
        let after: string | undefined
        if (cursor.eatKeyword("before")) before = cursor.eatString()
        else if (cursor.eatKeyword("after")) after = cursor.eatString()
        return [{ ...base, kind: "addEnumValue", type, value, before, after }]
    }
    if (cursor.eatSequence("rename", "to")) {
        // Renaming the type itself, which TypeORM does while rewriting enums.
        return [benign(ctx)]
    }
    return [unknown(ctx, "unsupported-shape", ["alter", "type"])]
}

function parseAlterSchema(cursor: TokenCursor, ctx: Ctx): Operation[] {
    const base = meta(ctx)
    const from = cursor.eatIdent()
    if (cursor.eatSequence("rename", "to")) {
        const to = cursor.eatIdent()
        if (from && to) return [{ ...base, kind: "renameSchema", from, to }]
    }
    return [benign(ctx)]
}

// ── CREATE ───────────────────────────────────────────────────────────────────

function parseCreate(cursor: TokenCursor, ctx: Ctx): Operation[] {
    cursor.eatKeyword("create")
    cursor.eatSequence("or", "replace")
    cursor.eatKeyword("temporary")
    cursor.eatKeyword("temp")
    cursor.eatKeyword("unlogged")

    const unique = cursor.eatKeyword("unique")
    const fulltext = cursor.eatKeyword("fulltext")
    const spatial = cursor.eatKeyword("spatial")

    if (cursor.eatKeyword("index")) {
        return parseCreateIndex(cursor, ctx, { unique, fulltext, spatial })
    }
    if (cursor.eatKeyword("table")) return parseCreateTable(cursor, ctx)

    const next = cursor.peek()?.lower ?? "?"
    if (PROCEDURAL.has(next))
        return [unknown(ctx, "procedural-block", ["create", next])]

    // CREATE TYPE / VIEW / SCHEMA / SEQUENCE / DATABASE / EXTENSION: all safe.
    return [benign(ctx)]
}

function parseCreateIndex(
    cursor: TokenCursor,
    ctx: Ctx,
    flags: { unique: boolean; fulltext: boolean; spatial: boolean },
): Operation[] {
    const base = meta(ctx)
    const concurrent = cursor.eatKeyword("concurrently")
    cursor.eatSequence("if", "not", "exists")
    const name = cursor.isKeyword("on")
        ? undefined
        : cursor.eatQualifiedName()?.name
    if (!cursor.eatKeyword("on"))
        return [unknown(ctx, "unsupported-shape", ["create", "index"])]
    // `ON ONLY parent` targets a partitioned parent without recursing.
    cursor.eatKeyword("only")
    const table = toTable(cursor.eatQualifiedName())

    let using: string | undefined
    if (cursor.eatKeyword("using")) using = cursor.eatIdent()

    const columns = readIndexColumns(cursor)

    let where: string | undefined
    let include: string[] | undefined
    let nullsNotDistinct = false
    let mysql: MysqlAlterOptions | undefined
    const unmodeled: string[] = []

    /**
     * A loop, not a fixed chain. The previous version tried each clause once in a
     * fixed order, so a single unrecognized clause consumed nothing and blocked every
     * clause after it — `... WITH (fillfactor = 90) WHERE deleted_at IS NULL` silently
     * lost the predicate, and `safeByDefault` then rebuilt a partial index as a full
     * one. Anything not modelled is recorded rather than dropped.
     */
    let guard = 0
    while (!cursor.done && guard < 32) {
        guard += 1

        // MySQL allows USING after the column list as well as before it.
        if (cursor.eatKeyword("using")) {
            using = cursor.eatIdent()
            continue
        }
        if (cursor.eatKeyword("include")) {
            include = readNameList(cursor)
            continue
        }
        if (cursor.eatSequence("nulls", "not", "distinct")) {
            nullsNotDistinct = true
            continue
        }
        if (cursor.eatSequence("nulls", "distinct")) continue
        if (cursor.eatKeyword("where")) {
            where = cursor.takeUntilTopLevelComma()
            continue
        }
        // ALGORITHM=/LOCK= are legal on CREATE INDEX too, not just ALTER TABLE.
        const option = readMysqlAlterOption(cursor)
        if (option) {
            mysql = { ...mysql, ...option }
            continue
        }

        // WITH (...), TABLESPACE x, VISIBLE/INVISIBLE, COMMENT '...', WITH PARSER ngram.
        const start = cursor.pos
        const token = cursor.peek()
        if (!token) break
        cursor.pos += 1
        if (cursor.isPunct("(")) cursor.eatParenGroup()
        else if (cursor.peek() && !isTailKeyword(cursor)) cursor.pos += 1
        const text = cursor.rawFrom(start)
        if (text) unmodeled.push(text)
    }

    return [
        {
            ...base,
            kind: "createIndex",
            table,
            name,
            columns,
            unique: flags.unique,
            concurrent,
            where,
            using,
            include,
            nullsNotDistinct: nullsNotDistinct || undefined,
            fulltext: flags.fulltext,
            spatial: flags.spatial,
            mysql,
            // Consumers that rebuild this statement must refuse when it is set.
            partial: unmodeled.length > 0 || undefined,
            unmodeledClauses: unmodeled.length > 0 ? unmodeled : undefined,
        },
    ]
}

/** Keywords that begin a clause the loop above knows how to handle. */
function isTailKeyword(cursor: TokenCursor): boolean {
    const token = cursor.peek()
    if (!token || token.kind !== "word") return false
    return ["using", "include", "nulls", "where", "algorithm", "lock"].includes(
        token.lower,
    )
}

function parseCreateTable(cursor: TokenCursor, ctx: Ctx): Operation[] {
    const base = meta(ctx)
    const ifNotExists = cursor.eatSequence("if", "not", "exists")
    const table = toTable(cursor.eatQualifiedName())
    const columns: ReturnType<typeof parseColumnDef>[] = []

    if (cursor.isPunct("(")) {
        cursor.pos += 1
        while (!cursor.done) {
            if (cursor.isPunct(")")) {
                cursor.pos += 1
                break
            }
            // Table-level constraints are not columns.
            if (
                cursor.isKeyword("constraint") ||
                cursor.isKeyword("primary") ||
                cursor.isKeyword("unique") ||
                cursor.isKeyword("check") ||
                cursor.isKeyword("foreign") ||
                cursor.isKeyword("exclude") ||
                cursor.isKeyword("index") ||
                cursor.isKeyword("key") ||
                cursor.isKeyword("fulltext") ||
                cursor.isKeyword("spatial")
            ) {
                cursor.skipToTopLevelComma()
            } else {
                const column = parseColumnDef(cursor, ctx.dialect)
                if (column) columns.push(column)
                else cursor.skipToTopLevelComma()
            }
            if (!cursor.eatPunct(",")) {
                if (cursor.isPunct(")")) {
                    cursor.pos += 1
                    break
                }
                // Not where we expected to be; stop rather than loop forever.
                if (!cursor.done) cursor.skipToTopLevelComma()
                if (!cursor.eatPunct(",")) break
            }
        }
    }

    return [
        {
            ...base,
            kind: "createTable",
            table,
            columns: columns.filter(
                (column): column is NonNullable<typeof column> => !!column,
            ),
            ifNotExists,
        },
    ]
}

// ── DROP / RENAME / TRUNCATE / DML ──────────────────────────────────────────

function parseDrop(cursor: TokenCursor, ctx: Ctx): Operation[] {
    const base = meta(ctx)
    cursor.eatKeyword("drop")

    if (cursor.eatKeyword("table")) {
        const ifExists = cursor.eatSequence("if", "exists")
        const tables: TableRef[] = []
        do {
            const name = cursor.eatQualifiedName()
            if (name) tables.push(toTable(name))
        } while (cursor.eatPunct(","))
        const cascade = cursor.eatKeyword("cascade")
        return [{ ...base, kind: "dropTable", tables, ifExists, cascade }]
    }

    if (cursor.eatKeyword("index")) {
        const concurrent = cursor.eatKeyword("concurrently")
        cursor.eatSequence("if", "exists")
        const first = cursor.eatQualifiedName()
        // MySQL: DROP INDEX name ON table
        let table: TableRef | undefined
        if (cursor.eatKeyword("on")) table = toTable(cursor.eatQualifiedName())
        else if (first?.schema) table = undefined
        return [
            {
                ...base,
                kind: "dropIndex",
                table,
                name: first?.name ?? "?",
                concurrent,
            },
        ]
    }

    // Both of these are unrecoverable, and both used to be classified benign — which
    // meant `from-sql` filtered them out before any check could see them.
    if (cursor.eatKeyword("schema")) {
        cursor.eatSequence("if", "exists")
        const schema = cursor.eatIdent() ?? "?"
        const cascade = cursor.eatKeyword("cascade")
        return [{ ...base, kind: "dropSchema", schema, cascade }]
    }

    if (cursor.eatKeyword("database")) {
        cursor.eatSequence("if", "exists")
        return [
            {
                ...base,
                kind: "dropDatabase",
                database: cursor.eatIdent() ?? "?",
            },
        ]
    }

    const materialized = cursor.eatKeyword("materialized")
    if (cursor.eatKeyword("view")) {
        const ifExists = cursor.eatSequence("if", "exists")
        const views: TableRef[] = []
        do {
            const name = cursor.eatQualifiedName()
            if (name) views.push(toTable(name))
        } while (cursor.eatPunct(","))
        const cascade = cursor.eatKeyword("cascade")
        return [
            {
                ...base,
                kind: "dropView",
                views,
                materialized,
                ifExists,
                cascade,
            },
        ]
    }

    const next = cursor.peek()?.lower ?? "?"
    if (PROCEDURAL.has(next))
        return [unknown(ctx, "procedural-block", ["drop", next])]
    // DROP TYPE / SEQUENCE / CONSTRAINT — metadata only.
    return [benign(ctx)]
}

/** MySQL's `RENAME TABLE a TO b[, c TO d]`. */
function parseRenameTable(cursor: TokenCursor, ctx: Ctx): Operation[] {
    const base = meta(ctx)
    cursor.eatKeyword("rename")
    if (!cursor.eatKeyword("table"))
        return [unknown(ctx, "unsupported-shape", ["rename"])]
    const operations: Operation[] = []
    do {
        const from = cursor.eatQualifiedName()
        if (!cursor.eatKeyword("to")) break
        const to = cursor.eatQualifiedName()
        if (from && to) {
            operations.push({
                ...base,
                kind: "renameTable",
                table: toTable(from),
                newName: to.name,
            })
        }
    } while (cursor.eatPunct(","))
    return operations
}

function parseTruncate(cursor: TokenCursor, ctx: Ctx): Operation[] {
    const base = meta(ctx)
    cursor.eatKeyword("truncate")
    cursor.eatKeyword("table")
    const tables: TableRef[] = []
    do {
        const name = cursor.eatQualifiedName()
        if (name) tables.push(toTable(name))
    } while (cursor.eatPunct(","))
    const cascade = cursor.eatKeyword("cascade")
    return [{ ...base, kind: "truncate", tables, cascade }]
}

/**
 * An UPDATE or DELETE with no WHERE rewrites the whole table. That is the
 * backfill-in-a-migration hazard the gem documents but cannot detect, because it
 * only ever sees an opaque `execute`.
 */
function parseDml(
    cursor: TokenCursor,
    ctx: Ctx,
    verb: "UPDATE" | "DELETE",
): Operation[] {
    const base = meta(ctx)
    cursor.pos += 1
    if (verb === "DELETE") cursor.eatKeyword("from")
    cursor.eatSequence("low_priority")
    cursor.eatKeyword("ignore")
    const table = cursor.eatQualifiedName()

    // Depth-aware: a WHERE or LIMIT nested in a subquery bounds the subquery, not the
    // UPDATE. Scanning every token meant `UPDATE users SET x = (SELECT 1 FROM t WHERE
    // t.id = users.id)` looked bounded and the full-table rewrite went unreported.
    let depth = 0
    let bounded = false
    for (const token of cursor.tokens) {
        if (token.kind === "punct" && token.value === "(") depth += 1
        else if (token.kind === "punct" && token.value === ")") depth -= 1
        else if (
            depth === 0 &&
            token.kind === "word" &&
            (token.lower === "where" || token.lower === "limit")
        ) {
            bounded = true
            break
        }
    }
    if (bounded) return [benign(ctx)]

    return [
        {
            ...base,
            kind: "backfill",
            verb,
            tables: table ? [toTable(table)] : [],
            sql: ctx.statement.sql,
        },
    ]
}
