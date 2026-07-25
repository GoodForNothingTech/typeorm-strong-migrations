import type { Dialect } from "../operations/types"

/**
 * Splitting and tokenizing are one pass, because a splitter that is actually
 * correct is already a lexer. Every hazard that would break naive splitting on
 * `;` — dollar-quoted bodies, `''` escapes, MySQL backslash escapes, nesting block
 * comments, semicolons inside string literals and comments — is a lexical concern,
 * so solving it once here means the grammar layer above can be simple.
 *
 * TypeORM's `migration:generate --pretty` reformats SQL through @sqltools/formatter,
 * changing whitespace and keyword case, so nothing downstream may match on layout.
 */

export type TokenKind =
    "word" | "ident" | "string" | "number" | "punct" | "operator" | "param"

export interface Token {
    kind: TokenKind
    /** Decoded value: identifier without quotes, string without delimiters. */
    value: string
    /** Lower-cased `value`, for keyword comparison. */
    lower: string
    /** Exact source slice. */
    raw: string
    start: number
    end: number
    quoted?: boolean
}

export interface RawStatement {
    sql: string
    start: number
    end: number
    tokens: Token[]
    /** Retained so `-- strong-migrations:ignore` markers survive. */
    leadingComments: string[]
    /**
     * Every comment in the statement, wherever it sits. Marker detection scans only
     * these: searching the whole statement text matched the marker inside ordinary
     * string literals, so `INSERT INTO audit (note) VALUES
     * ('strong-migrations:safety-assured')` silently disabled every check.
     */
    comments: string[]
    /** The lexer gave up part-way; treat the statement as uninterpretable. */
    lexError?: boolean
}

export interface LexerOptions {
    /** MySQL sql_mode ANSI_QUOTES: `"` becomes an identifier delimiter. */
    ansiQuotes?: boolean
    /** MySQL sql_mode NO_BACKSLASH_ESCAPES. */
    noBackslashEscapes?: boolean
}

const MULTI_CHAR_OPERATORS = [
    "->>",
    "#>>",
    "<<=",
    ">>=",
    "::",
    ":=",
    "->",
    "#>",
    "@>",
    "<@",
    "||",
    "&&",
    "<=",
    ">=",
    "<>",
    "!=",
    "<<",
    ">>",
    "!~",
    "~*",
]

const PUNCTUATION = new Set(["(", ")", ",", ".", ";", "[", "]"])

const isSpace = (char: string): boolean =>
    char === " " ||
    char === "\t" ||
    char === "\n" ||
    char === "\r" ||
    char === "\f"
const isDigit = (char: string): boolean => char >= "0" && char <= "9"
const isIdentStart = (char: string): boolean =>
    (char >= "a" && char <= "z") ||
    (char >= "A" && char <= "Z") ||
    char === "_" ||
    // Both engines allow non-ASCII characters in unquoted identifiers.
    char >= ""
const isIdentPart = (char: string): boolean =>
    isIdentStart(char) || isDigit(char) || char === "$"

export function splitStatements(
    sql: string,
    dialect: Dialect,
    options: LexerOptions = {},
): RawStatement[] {
    const isPostgres = dialect === "postgres"
    const backslashEscapes = !isPostgres && !options.noBackslashEscapes
    const doubleQuoteIsIdent = isPostgres || options.ansiQuotes === true

    const statements: RawStatement[] = []
    let tokens: Token[] = []
    let comments: string[] = []
    let allComments: string[] = []
    let statementStart = 0
    let index = 0
    const length = sql.length

    const flush = (end: number, lexError = false): void => {
        const slice = sql.slice(statementStart, end)
        // Emit even with no tokens when the lexer gave up. Dropping the statement made
        // `analyzeSql` return an empty array, and zero operations means the checker
        // runs the query with no checks at all — the worst possible outcome for input
        // we explicitly could not understand (e.g. a leading unterminated block
        // comment hiding a DROP COLUMN).
        if (tokens.length > 0 || (lexError && slice.trim() !== "")) {
            // `start` must be the absolute offset of `sql[0]`, not of the raw slice:
            // TokenCursor maps absolute token offsets back into `sql` by subtracting
            // it, so trimming the text without advancing the anchor shifts every
            // extracted fragment (CHECK expressions, index predicates, expression
            // columns) by the number of characters trimmed.
            const leading = slice.length - slice.trimStart().length
            statements.push({
                sql: slice.trim(),
                start: statementStart + leading,
                end,
                tokens,
                leadingComments: comments,
                comments: allComments,
                lexError: lexError || undefined,
            })
        }
        tokens = []
        comments = []
        allComments = []
        statementStart = end + 1
    }

    const push = (
        kind: TokenKind,
        value: string,
        start: number,
        end: number,
        quoted?: boolean,
    ): void => {
        tokens.push({
            kind,
            value,
            lower: value.toLowerCase(),
            raw: sql.slice(start, end),
            start,
            end,
            quoted,
        })
    }

    while (index < length) {
        const char = sql[index]!

        if (isSpace(char)) {
            index += 1
            continue
        }

        // Line comments. Postgres always treats `--` as one; MySQL requires a space
        // after, because `--x` there is negation applied twice.
        if (
            char === "-" &&
            sql[index + 1] === "-" &&
            (isPostgres ||
                sql[index + 2] === undefined ||
                isSpace(sql[index + 2]!))
        ) {
            const end = nextNewline(sql, index)
            const text = sql.slice(index, end)
            allComments.push(text)
            if (tokens.length === 0) comments.push(text)
            index = end
            continue
        }

        if (char === "#" && !isPostgres) {
            const end = nextNewline(sql, index)
            allComments.push(sql.slice(index, end))
            if (tokens.length === 0) comments.push(sql.slice(index, end))
            index = end
            continue
        }

        if (char === "/" && sql[index + 1] === "*") {
            // MySQL `/*! ... */` is executable, not a comment: strip the wrapper and
            // keep lexing the contents.
            if (!isPostgres && sql[index + 2] === "!") {
                index += 3
                while (index < length && isDigit(sql[index]!)) index += 1
                continue
            }
            const start = index
            let depth = 1
            index += 2
            while (index < length && depth > 0) {
                if (
                    isPostgres &&
                    sql[index] === "/" &&
                    sql[index + 1] === "*"
                ) {
                    depth += 1
                    index += 2
                } else if (sql[index] === "*" && sql[index + 1] === "/") {
                    depth -= 1
                    index += 2
                } else index += 1
            }
            if (depth > 0) {
                flush(length, true)
                return statements
            }
            allComments.push(sql.slice(start, index))
            if (tokens.length === 0) comments.push(sql.slice(start, index))
            continue
        }

        if (char === "'" || (char === '"' && !doubleQuoteIsIdent)) {
            const start = index
            const result = readQuoted(sql, index, char, backslashEscapes)
            if (result === undefined) {
                flush(length, true)
                return statements
            }
            push("string", result.value, start, result.end)
            index = result.end
            continue
        }

        if (char === '"' && doubleQuoteIsIdent) {
            const start = index
            const result = readQuoted(sql, index, '"', false)
            if (result === undefined) {
                flush(length, true)
                return statements
            }
            push("ident", result.value, start, result.end, true)
            index = result.end
            continue
        }

        if (char === "`" && !isPostgres) {
            const start = index
            const result = readQuoted(sql, index, "`", false)
            if (result === undefined) {
                flush(length, true)
                return statements
            }
            push("ident", result.value, start, result.end, true)
            index = result.end
            continue
        }

        if (char === "$" && isPostgres) {
            // `$1` is a bind parameter; `$tag$` opens a dollar-quoted body.
            if (isDigit(sql[index + 1] ?? "")) {
                const start = index
                index += 1
                while (index < length && isDigit(sql[index]!)) index += 1
                push("param", sql.slice(start, index), start, index)
                continue
            }
            const tagMatch = /^\$(?:[A-Za-z_-￿][A-Za-z0-9_-￿]*)?\$/.exec(
                sql.slice(index),
            )
            if (tagMatch) {
                const tag = tagMatch[0]
                const bodyStart = index + tag.length
                const close = sql.indexOf(tag, bodyStart)
                if (close === -1) {
                    flush(length, true)
                    return statements
                }
                const start = index
                index = close + tag.length
                push("string", sql.slice(bodyStart, close), start, index)
                continue
            }
        }

        // Postgres string prefixes: E'', U&'', B'', X''
        if (isPostgres && /[EeUuBbXxNn]/.test(char)) {
            const next = sql[index + 1]
            const isUnicodePrefix =
                (char === "U" || char === "u") &&
                next === "&" &&
                sql[index + 2] === "'"
            if (next === "'" || isUnicodePrefix) {
                const start = index
                const quoteAt = isUnicodePrefix ? index + 2 : index + 1
                const allowBackslash = char === "E" || char === "e"
                const result = readQuoted(sql, quoteAt, "'", allowBackslash)
                if (result === undefined) {
                    flush(length, true)
                    return statements
                }
                push("string", result.value, start, result.end)
                index = result.end
                continue
            }
        }

        if (char === ";") {
            flush(index)
            index += 1
            continue
        }

        if (isDigit(char) || (char === "." && isDigit(sql[index + 1] ?? ""))) {
            const start = index
            const match =
                /^(?:0[xX][0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?)/.exec(
                    sql.slice(index),
                )
            index += match ? match[0].length : 1
            push("number", sql.slice(start, index), start, index)
            continue
        }

        if (isIdentStart(char)) {
            const start = index
            index += 1
            while (index < length && isIdentPart(sql[index]!)) index += 1
            push("word", sql.slice(start, index), start, index)
            continue
        }

        if (PUNCTUATION.has(char)) {
            push("punct", char, index, index + 1)
            index += 1
            continue
        }

        const operator = MULTI_CHAR_OPERATORS.find((candidate) =>
            sql.startsWith(candidate, index),
        )
        if (operator) {
            push("operator", operator, index, index + operator.length)
            index += operator.length
            continue
        }

        push("operator", char, index, index + 1)
        index += 1
    }

    flush(length)
    return statements
}

function nextNewline(sql: string, from: number): number {
    const index = sql.indexOf("\n", from)
    return index === -1 ? sql.length : index
}

interface QuotedResult {
    value: string
    end: number
}

/**
 * Reads a delimited run. `doubled` covers both `''` inside a string and `""`/```` ``
 * inside an identifier; `backslashEscapes` is MySQL's default and Postgres's E''.
 */
function readQuoted(
    sql: string,
    start: number,
    delimiter: string,
    backslashEscapes: boolean,
): QuotedResult | undefined {
    let index = start + 1
    let value = ""
    while (index < sql.length) {
        const char = sql[index]!
        if (backslashEscapes && char === "\\") {
            value += sql[index + 1] ?? ""
            index += 2
            continue
        }
        if (char === delimiter) {
            if (sql[index + 1] === delimiter) {
                value += delimiter
                index += 2
                continue
            }
            return { value, end: index + 1 }
        }
        value += char
        index += 1
    }
    return undefined
}
