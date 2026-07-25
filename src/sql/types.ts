import type { Dialect, SqlType } from "../operations/types"

/**
 * Alias resolution so `varchar(255)` and `character varying(255)` compare equal.
 * Postgres and MySQL are kept separate on purpose: bare `timestamp` means
 * "without time zone" in Postgres but is its own UTC-converting type in MySQL.
 */
export const TYPE_ALIASES: Record<Dialect, Record<string, string>> = {
    postgres: {
        int: "integer",
        int4: "integer",
        int2: "smallint",
        int8: "bigint",
        serial: "integer",
        serial4: "integer",
        serial2: "smallint",
        smallserial: "smallint",
        serial8: "bigint",
        bigserial: "bigint",
        varchar: "character varying",
        char: "character",
        bpchar: "character",
        decimal: "numeric",
        float4: "real",
        float8: "double precision",
        bool: "boolean",
        timestamptz: "timestamp with time zone",
        timestamp: "timestamp without time zone",
        timetz: "time with time zone",
        time: "time without time zone",
        varbit: "bit varying",
    },
    mysql: {
        integer: "int",
        int4: "int",
        dec: "decimal",
        numeric: "decimal",
        fixed: "decimal",
        bool: "tinyint",
        boolean: "tinyint",
        "double precision": "double",
        real: "double",
    },
    mariadb: {
        integer: "int",
        int4: "int",
        dec: "decimal",
        numeric: "decimal",
        fixed: "decimal",
        bool: "tinyint",
        boolean: "tinyint",
        "double precision": "double",
        real: "double",
    },
}

/** Types whose declaration implies an auto-incrementing sequence (Postgres). */
export const SERIAL_TYPES = new Set([
    "serial",
    "serial2",
    "serial4",
    "serial8",
    "smallserial",
    "bigserial",
])

/**
 * Own-property lookup. These tables are keyed by text lifted straight out of the
 * SQL, so a type named `constructor`, `toString` or `__proto__` would otherwise
 * resolve to an inherited Object.prototype member — truthy, and the wrong shape.
 * `MULTIWORD_CONTINUATIONS["constructor"]` returning a function made the loop below
 * throw `beforeArgs is not iterable`, and that path reaches a migration uncaught.
 */
function own<T>(map: Record<string, T>, key: string): T | undefined {
    return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined
}

/**
 * Multi-word base types. These have to be matched greedily and *around* the
 * parameter list, because Postgres writes `timestamp(3) with time zone`.
 */
const MULTIWORD_CONTINUATIONS: Record<string, string[][]> = {
    character: [["varying"]],
    double: [["precision"]],
    bit: [["varying"]],
    timestamp: [
        ["with", "time", "zone"],
        ["without", "time", "zone"],
    ],
    time: [
        ["with", "time", "zone"],
        ["without", "time", "zone"],
    ],
}

interface Scanner {
    text: string
    pos: number
}

function skipSpace(scanner: Scanner): void {
    while (
        scanner.pos < scanner.text.length &&
        /\s/.test(scanner.text[scanner.pos]!)
    )
        scanner.pos += 1
}

function readWord(scanner: Scanner): string | undefined {
    skipSpace(scanner)
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(
        scanner.text.slice(scanner.pos),
    )
    if (!match) return undefined
    scanner.pos += match[0].length
    return match[0]
}

function peekWord(scanner: Scanner): string | undefined {
    const saved = scanner.pos
    const word = readWord(scanner)
    scanner.pos = saved
    return word
}

function readQuotedIdent(scanner: Scanner): string | undefined {
    skipSpace(scanner)
    const char = scanner.text[scanner.pos]
    if (char !== '"' && char !== "`") return undefined
    const close = char
    let out = ""
    scanner.pos += 1
    while (scanner.pos < scanner.text.length) {
        if (scanner.text[scanner.pos] === close) {
            if (scanner.text[scanner.pos + 1] === close) {
                out += close
                scanner.pos += 2
                continue
            }
            scanner.pos += 1
            return out
        }
        out += scanner.text[scanner.pos]
        scanner.pos += 1
    }
    return out
}

function readParenGroup(scanner: Scanner): string | undefined {
    skipSpace(scanner)
    if (scanner.text[scanner.pos] !== "(") return undefined
    let depth = 0
    const start = scanner.pos
    while (scanner.pos < scanner.text.length) {
        const char = scanner.text[scanner.pos]
        if (char === "'") {
            scanner.pos += 1
            while (scanner.pos < scanner.text.length) {
                if (
                    scanner.text[scanner.pos] === "'" &&
                    scanner.text[scanner.pos + 1] === "'"
                ) {
                    scanner.pos += 2
                    continue
                }
                if (scanner.text[scanner.pos] === "'") break
                scanner.pos += 1
            }
        } else if (char === "(") depth += 1
        else if (char === ")") {
            depth -= 1
            if (depth === 0) {
                scanner.pos += 1
                return scanner.text.slice(start + 1, scanner.pos - 1)
            }
        }
        scanner.pos += 1
    }
    return scanner.text.slice(start + 1)
}

/**
 * Parses a SQL type declaration into its comparable parts.
 *
 * Handles the shapes TypeORM actually emits, including `numeric(12,7) array`
 * (PostgresDriver.createFullType appends a literal " array") and schema-qualified
 * user types like `"public"."status_enum"[]`.
 */
export function parseSqlType(text: string, dialect: Dialect): SqlType {
    const raw = text.trim()
    const scanner: Scanner = { text: raw, pos: 0 }

    // Qualified or quoted user type: "public"."status_enum"
    const parts: string[] = []
    let quoted = false
    for (;;) {
        const quotedIdent = readQuotedIdent(scanner)
        if (quotedIdent !== undefined) {
            quoted = true
            parts.push(quotedIdent)
        } else {
            const word = readWord(scanner)
            if (word === undefined) break
            parts.push(word)
        }
        skipSpace(scanner)
        if (scanner.text[scanner.pos] === ".") {
            scanner.pos += 1
            continue
        }
        break
    }

    if (parts.length === 0) {
        return {
            baseType: raw.toLowerCase(),
            raw,
            writtenType: raw,
            isArray: false,
            isUserDefined: false,
        }
    }

    let written = parts.join(".")
    let lower = parts[parts.length - 1]!.toLowerCase()
    const qualified = parts.length > 1

    // Leading multi-word continuation, e.g. "character varying" or "double precision".
    const beforeArgs = own(MULTIWORD_CONTINUATIONS, lower)
    if (!qualified && beforeArgs) {
        for (const continuation of beforeArgs) {
            const saved = scanner.pos
            const matched: string[] = []
            let ok = true
            for (const expected of continuation) {
                const word = readWord(scanner)
                if (!word || word.toLowerCase() !== expected) {
                    ok = false
                    break
                }
                matched.push(word)
            }
            if (ok) {
                lower = `${lower} ${continuation.join(" ")}`
                written = `${written} ${matched.join(" ")}`
                break
            }
            scanner.pos = saved
        }
    }

    // Parameters: (255) | (10,2) | ('a','b')
    let length: number | undefined
    let precision: number | undefined
    let scale: number | undefined
    let enumValues: string[] | undefined
    const args = readParenGroup(scanner)
    if (args !== undefined) {
        const trimmed = args.trim()
        if (/^\s*'/.test(trimmed)) {
            enumValues = trimmed
                .split(",")
                .map((value) =>
                    value.trim().replace(/^'|'$/g, "").replaceAll("''", "'"),
                )
        } else {
            const numbers = trimmed
                .split(",")
                .map((value) => Number.parseInt(value.trim(), 10))
            if (numbers.length >= 1 && Number.isFinite(numbers[0])) {
                if (numbers.length === 1) {
                    // A single argument is a length for string/bit types and a
                    // precision for numeric and temporal ones.
                    if (isLengthType(lower)) length = numbers[0]
                    else precision = numbers[0]
                } else {
                    precision = numbers[0]
                    scale = Number.isFinite(numbers[1]) ? numbers[1] : undefined
                }
            }
        }
    }

    // Trailing multi-word continuation, e.g. "timestamp(3) with time zone".
    const afterArgs = own(MULTIWORD_CONTINUATIONS, lower)
    if (!qualified && afterArgs && !lower.includes(" ")) {
        for (const continuation of afterArgs) {
            const saved = scanner.pos
            const matched: string[] = []
            let ok = true
            for (const expected of continuation) {
                const word = readWord(scanner)
                if (!word || word.toLowerCase() !== expected) {
                    ok = false
                    break
                }
                matched.push(word)
            }
            if (ok) {
                lower = `${lower} ${continuation.join(" ")}`
                written = `${written} ${matched.join(" ")}`
                break
            }
            scanner.pos = saved
        }
    }

    // Modifiers and array suffixes.
    let unsigned = false
    let isArray = false
    for (;;) {
        skipSpace(scanner)
        if (scanner.text[scanner.pos] === "[") {
            isArray = true
            const close = scanner.text.indexOf("]", scanner.pos)
            scanner.pos = close === -1 ? scanner.text.length : close + 1
            continue
        }
        const word = peekWord(scanner)
        if (!word) break
        const lowered = word.toLowerCase()
        if (lowered === "array") {
            readWord(scanner)
            isArray = true
            continue
        }
        if (lowered === "unsigned") {
            readWord(scanner)
            unsigned = true
            continue
        }
        if (lowered === "zerofill") {
            readWord(scanner)
            continue
        }
        break
    }

    const aliases = TYPE_ALIASES[dialect]
    const baseType =
        qualified || quoted
            ? parts.join(".").toLowerCase()
            : (own(aliases, lower) ?? lower)

    return {
        baseType,
        raw,
        writtenType: written,
        length,
        precision,
        scale,
        isArray,
        withTimeZone: baseType.includes("with time zone") ? true : undefined,
        unsigned: unsigned || undefined,
        isUserDefined: qualified || quoted,
        enumValues,
    }
}

function isLengthType(type: string): boolean {
    return /^(var)?char|^character|^bit|^varbit|^binary|^varbinary|^nchar|^nvarchar|^string/.test(
        type,
    )
}

/** Postgres SERIAL family is sugar, not a type — normalize it away. */
export function serialImpliedType(written: string): string | undefined {
    const lower = written.toLowerCase()
    if (!SERIAL_TYPES.has(lower)) return undefined
    if (lower === "bigserial" || lower === "serial8") return "bigint"
    if (lower === "smallserial" || lower === "serial2") return "smallint"
    return "integer"
}
