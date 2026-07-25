import type { ColumnSpec, Dialect } from "../operations/types"
import type { TokenCursor } from "./cursor"
import { readDefault } from "./defaults"
import { parseSqlType, serialImpliedType } from "./types"

/**
 * Keywords that end a type declaration and begin a column constraint.
 *
 * `character` and `time` are ambiguous — `CHARACTER SET utf8` is a constraint while
 * `CHARACTER VARYING` is part of the type — so they are resolved by lookahead
 * rather than membership.
 */
const CONSTRAINT_STARTERS = new Set([
    "not",
    "null",
    "default",
    "primary",
    "unique",
    "check",
    "references",
    "generated",
    "auto_increment",
    "collate",
    "comment",
    "constraint",
    "storage",
    "on",
    "as",
    "identity",
    "srid",
    "invisible",
    "visible",
    "column_format",
    // Postgres `ALTER COLUMN ... TYPE t USING <expr>`: without this the USING clause
    // was swallowed into the type text, so `grammar.parseAlterColumn` never saw it and
    // the cast expression that decides whether the change is safe was invisible.
    "using",
])

function endsType(cursor: TokenCursor): boolean {
    const token = cursor.peek()
    if (!token) return true
    if (token.kind === "punct")
        return token.value === "," || token.value === ")"
    if (token.kind !== "word") return false
    const lower = token.lower
    if (lower === "character") {
        // CHARACTER SET ends the type; CHARACTER VARYING continues it.
        return cursor.peek(1)?.lower === "set"
    }
    if (lower === "with" || lower === "without") {
        // `WITH TIME ZONE` continues the type; anything else does not.
        return cursor.peek(1)?.lower !== "time"
    }
    return CONSTRAINT_STARTERS.has(lower)
}

/** Consumes the type declaration and returns its exact source text. */
export function readTypeText(cursor: TokenCursor): string {
    const start = cursor.pos
    let guard = 0
    while (!cursor.done && guard < 64) {
        guard += 1
        if (cursor.pos > start && endsType(cursor)) break
        if (cursor.isPunct("(")) {
            cursor.eatParenGroup()
            continue
        }
        if (cursor.isPunct("[")) {
            cursor.pos += 1
            while (!cursor.done && !cursor.isPunct("]")) cursor.pos += 1
            cursor.eatPunct("]")
            continue
        }
        const token = cursor.peek()
        if (!token) break
        if (token.kind === "punct" && token.value !== ".") break
        cursor.pos += 1
    }
    return cursor.rawFrom(start)
}

/**
 * Parses `name type [constraints...]` as it appears inside CREATE TABLE and after
 * ALTER TABLE ADD. Unrecognized trailing clauses are skipped rather than failing
 * the whole statement.
 */
export function parseColumnDef(
    cursor: TokenCursor,
    dialect: Dialect,
): ColumnSpec | undefined {
    const start = cursor.pos
    const name = cursor.eatIdent()
    if (name === undefined) return undefined

    const typeText = readTypeText(cursor)
    const type = typeText ? parseSqlType(typeText, dialect) : undefined

    const column: ColumnSpec = { name, type }

    // SERIAL/BIGSERIAL are sugar for integer plus a sequence.
    const implied = type
        ? serialImpliedType(type.writtenType.split(/\s+/)[0] ?? "")
        : undefined
    if (implied && type) {
        type.baseType = implied
        column.autoIncrement = { style: "serial" }
    }

    let guard = 0
    while (!cursor.done && guard < 64) {
        guard += 1
        if (cursor.isPunct(",") || cursor.isPunct(")")) break

        if (cursor.eatSequence("not", "null")) {
            column.nullable = false
            continue
        }
        if (cursor.eatKeyword("null")) {
            column.nullable = true
            continue
        }
        if (cursor.eatKeyword("default")) {
            column.default = readDefault(cursor)
            continue
        }
        if (cursor.eatSequence("primary", "key")) {
            column.isPrimaryKey = true
            continue
        }
        if (cursor.eatKeyword("unique")) {
            cursor.eatKeyword("key")
            column.isUnique = true
            continue
        }
        if (cursor.eatKeyword("auto_increment")) {
            column.autoIncrement = { style: "autoIncrement" }
            continue
        }
        if (cursor.eatKeyword("check")) {
            cursor.eatParenGroup()
            continue
        }
        if (cursor.eatKeyword("references")) {
            cursor.eatQualifiedName()
            if (cursor.isPunct("(")) cursor.eatParenGroup()
            continue
        }
        if (cursor.eatKeyword("generated")) {
            const mode = cursor.eatSequence("by", "default")
                ? "BY DEFAULT"
                : cursor.eatKeyword("always")
                  ? "ALWAYS"
                  : undefined
            if (cursor.eatKeyword("as")) {
                if (cursor.eatKeyword("identity")) {
                    if (cursor.isPunct("(")) cursor.eatParenGroup()
                    column.autoIncrement = {
                        style: "identity",
                        identityMode:
                            mode === "BY DEFAULT" ? "BY DEFAULT" : "ALWAYS",
                    }
                    continue
                }
                const expression = cursor.eatParenGroup() ?? ""
                const stored = cursor.eatKeyword("stored")
                if (!stored) cursor.eatKeyword("virtual")
                column.generated = {
                    expression,
                    storage: stored ? "STORED" : "VIRTUAL",
                }
                continue
            }
            continue
        }
        // MySQL's short generated-column form: `AS (expr) STORED`
        if (cursor.eatKeyword("as")) {
            const expression = cursor.eatParenGroup() ?? ""
            const stored = cursor.eatKeyword("stored")
            if (!stored) cursor.eatKeyword("virtual")
            column.generated = {
                expression,
                storage: stored ? "STORED" : "VIRTUAL",
            }
            continue
        }
        if (cursor.eatKeyword("collate")) {
            if (!cursor.eatQualifiedName()) cursor.eatString()
            continue
        }
        if (cursor.eatSequence("character", "set")) {
            if (!cursor.eatQualifiedName()) cursor.eatString()
            continue
        }
        if (cursor.eatKeyword("comment")) {
            column.comment = cursor.eatString()
            continue
        }
        if (cursor.eatSequence("on", "update")) {
            const value = readDefault(cursor)
            column.onUpdate = value?.raw
            continue
        }
        if (cursor.eatKeyword("constraint")) {
            cursor.eatIdent()
            continue
        }
        // Something we do not model; skip one token and record it, so the caller can
        // refuse to reconstruct a definition it only partly read.
        const skipped = cursor.peek()
        if (skipped)
            column.unmodeled = [...(column.unmodeled ?? []), skipped.value]
        cursor.pos += 1
    }

    // Hitting the cap means the definition was longer than we were willing to walk,
    // so the tail is unread rather than absent.
    if (guard >= 64)
        column.unmodeled = [...(column.unmodeled ?? []), "<truncated>"]

    column.raw = cursor.rawFrom(start)
    return column
}
