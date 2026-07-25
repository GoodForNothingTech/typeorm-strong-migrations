import type { Dialect, Operation } from "../operations/types"
import { parseStatement } from "./grammar"
import type { LexerOptions } from "./lexer"
import { splitStatements } from "./lexer"
import {
    disabledKeysFromSql,
    hasIgnoreMarker,
    hasSafetyAssuredMarker,
} from "../runtime/safety-assured"

export type AnalyzeOptions = LexerOptions

/**
 * Synchronous, pure, and never throws — it is called from inside the QueryRunner
 * wrapper, so a crash here would take down the migration it is meant to protect.
 * Anything it cannot interpret comes back as an `unknown` operation for the policy
 * layer to decide about.
 */
export function analyzeSql(
    sql: string,
    dialect: Dialect,
    options: AnalyzeOptions = {},
): Operation[] {
    let statements
    try {
        statements = splitStatements(sql, dialect, options)
    } catch {
        return [
            {
                source: "sql",
                raw: { sql },
                kind: "unknown",
                sql,
                reason: "lex-error",
                head: "?",
                looksLikeDdl: false,
            },
        ]
    }

    const operations: Operation[] = []
    for (const [index, statement] of statements.entries()) {
        let produced: Operation[]
        try {
            produced = parseStatement(statement, index, dialect)
        } catch {
            produced = [
                {
                    source: "sql",
                    raw: { sql: statement.sql },
                    kind: "unknown",
                    sql: statement.sql,
                    reason: "unsupported-shape",
                    head: statement.tokens[0]?.lower ?? "?",
                    looksLikeDdl: true,
                },
            ]
        }

        // Marker comments ride on the statement, so they survive every layer,
        // including the logger, which only ever sees the SQL text.
        // Comments only. Scanning the statement text as well meant the marker was
        // honoured when it appeared inside a string literal, so ordinary data could
        // switch off every check for that statement.
        const markerSource = statement.comments.join("\n")
        const safetyAssured =
            hasSafetyAssuredMarker(markerSource) ||
            hasIgnoreMarker(markerSource)
        const disabled = disabledKeysFromSql(markerSource)
        if (safetyAssured || disabled) {
            for (const op of produced) {
                op.markers = {
                    safetyAssured: safetyAssured || undefined,
                    disabled,
                }
            }
        }

        operations.push(...produced)
    }
    return operations
}
