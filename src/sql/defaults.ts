import type { DefaultValue } from "../operations/types"
import type { TokenCursor } from "./cursor"

/** Values that look like function calls but are written without parentheses. */
const NO_PAREN_KEYWORDS = new Set([
    "current_timestamp",
    "current_date",
    "current_time",
    "localtime",
    "localtimestamp",
    "current_user",
    "session_user",
    "user",
    "now",
])

/**
 * Classifies the expression after DEFAULT.
 *
 * The distinction that matters is call-versus-not. The gem tests
 * `default.to_s.include?("()")`, which also matches a string literal that happens
 * to contain parentheses; keying on a parsed call shape is the same intent without
 * that false positive.
 */
export function readDefault(cursor: TokenCursor): DefaultValue | undefined {
    const start = cursor.pos
    const first = cursor.peek()
    if (!first) return undefined

    if (first.kind === "word" && first.lower === "null") {
        cursor.pos += 1
        return { kind: "null", raw: cursor.rawFrom(start), containsCall: false }
    }

    if (first.kind === "string") {
        cursor.pos += 1
        return {
            kind: "literal",
            raw: cursor.rawFrom(start),
            containsCall: false,
            literal: first.value,
        }
    }

    if (
        first.kind === "number" ||
        (first.kind === "operator" && first.value === "-")
    ) {
        if (first.kind === "operator") cursor.pos += 1
        if (cursor.peek()?.kind === "number") cursor.pos += 1
        const raw = cursor.rawFrom(start)
        return {
            kind: "literal",
            raw,
            containsCall: false,
            literal: Number(raw),
        }
    }

    if (first.kind === "punct" && first.value === "(") {
        // MySQL expression default: DEFAULT (now()), DEFAULT (1 + 1)
        const inner = cursor.eatParenGroup() ?? ""
        const raw = cursor.rawFrom(start)
        const call = /^\s*(?:([A-Za-z_]\w*)\s*\.\s*)?([A-Za-z_]\w*)\s*\(/.exec(
            inner,
        )
        return {
            kind: "expression",
            raw,
            functionName: call?.[2]?.toLowerCase(),
            functionSchema: call?.[1]?.toLowerCase(),
            containsCall: inner.includes("("),
        }
    }

    if (first.kind === "word" || first.kind === "ident") {
        // Possibly-qualified name, optionally followed by a call.
        const name = cursor.eatQualifiedName()
        if (!name) return undefined

        if (cursor.isPunct("(")) {
            cursor.eatParenGroup()
            const raw = cursor.rawFrom(start)
            const lower = name.name.toLowerCase()
            return {
                kind: lower === "nextval" ? "sequence" : "functionCall",
                raw,
                functionName: lower,
                functionSchema: name.schema?.toLowerCase(),
                containsCall: true,
            }
        }

        // Typed literal: DATE '2020-01-01', INTERVAL '1 day'
        if (cursor.peek()?.kind === "string") {
            cursor.pos += 1
            return {
                kind: "literal",
                raw: cursor.rawFrom(start),
                containsCall: false,
            }
        }

        const lower = name.name.toLowerCase()
        if (NO_PAREN_KEYWORDS.has(lower)) {
            // CURRENT_TIMESTAMP(6) is still the keyword form.
            if (cursor.isPunct("(")) cursor.eatParenGroup()
            return {
                kind: "keyword",
                raw: cursor.rawFrom(start),
                functionName: lower,
                containsCall: false,
            }
        }
        if (lower === "true" || lower === "false") {
            return {
                kind: "literal",
                raw: cursor.rawFrom(start),
                containsCall: false,
                literal: lower === "true",
            }
        }
        // Bare identifier, e.g. an enum label written unquoted.
        return {
            kind: "expression",
            raw: cursor.rawFrom(start),
            containsCall: false,
        }
    }

    return undefined
}
