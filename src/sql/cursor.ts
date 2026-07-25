import type { RawStatement, Token } from "./lexer"

/**
 * A forgiving reader over a statement's tokens.
 *
 * Every parser built on this is expected to match what it understands and capture
 * the rest verbatim rather than failing. A linter that throws on unfamiliar SQL
 * would break the migration it was supposed to protect.
 */
export class TokenCursor {
    pos = 0

    constructor(readonly statement: RawStatement) {}

    get tokens(): Token[] {
        return this.statement.tokens
    }

    get done(): boolean {
        return this.pos >= this.tokens.length
    }

    peek(offset = 0): Token | undefined {
        return this.tokens[this.pos + offset]
    }

    next(): Token | undefined {
        return this.tokens[this.pos++]
    }

    /** Lower-cased words from the current position, for head matching. */
    peekWords(count: number): string[] {
        const out: string[] = []
        for (let index = 0; index < count; index += 1) {
            const token = this.peek(index)
            if (!token || (token.kind !== "word" && token.kind !== "ident"))
                break
            out.push(token.lower)
        }
        return out
    }

    isKeyword(word: string, offset = 0): boolean {
        const token = this.peek(offset)
        return (
            !!token &&
            token.kind === "word" &&
            token.lower === word.toLowerCase()
        )
    }

    /** Consumes the keyword when present. */
    eatKeyword(word: string): boolean {
        if (!this.isKeyword(word)) return false
        this.pos += 1
        return true
    }

    /** Consumes a whole keyword sequence, or nothing at all. */
    eatSequence(...words: string[]): boolean {
        const saved = this.pos
        for (const word of words) {
            if (!this.eatKeyword(word)) {
                this.pos = saved
                return false
            }
        }
        return true
    }

    eatPunct(value: string): boolean {
        const token = this.peek()
        if (!token || token.kind !== "punct" || token.value !== value)
            return false
        this.pos += 1
        return true
    }

    isPunct(value: string, offset = 0): boolean {
        const token = this.peek(offset)
        return !!token && token.kind === "punct" && token.value === value
    }

    /** An identifier: a quoted ident or a bare word. */
    eatIdent(): string | undefined {
        const token = this.peek()
        if (!token) return undefined
        if (token.kind === "ident" || token.kind === "word") {
            this.pos += 1
            return token.value
        }
        return undefined
    }

    /** `schema.name` or `db.schema.name`; returns the trailing parts. */
    eatQualifiedName(): { schema?: string; name: string } | undefined {
        const parts: string[] = []
        for (;;) {
            const ident = this.eatIdent()
            if (ident === undefined) break
            parts.push(ident)
            if (!this.eatPunct(".")) break
        }
        if (parts.length === 0) return undefined
        const name = parts[parts.length - 1]!
        const schema = parts.length > 1 ? parts[parts.length - 2] : undefined
        return schema === undefined ? { name } : { schema, name }
    }

    eatString(): string | undefined {
        const token = this.peek()
        if (!token || token.kind !== "string") return undefined
        this.pos += 1
        return token.value
    }

    /**
     * Consumes a balanced `( ... )` and returns its inner source text, so CHECK
     * expressions and generated-column bodies round-trip byte-exact.
     */
    eatParenGroup(): string | undefined {
        if (!this.isPunct("(")) return undefined
        const openToken = this.peek()!
        let depth = 0
        let closeToken: Token | undefined
        while (!this.done) {
            const token = this.next()!
            if (token.kind === "punct" && token.value === "(") depth += 1
            else if (token.kind === "punct" && token.value === ")") {
                depth -= 1
                if (depth === 0) {
                    closeToken = token
                    break
                }
            }
        }
        if (!closeToken) return this.sliceFrom(openToken.end)
        return this.statement.sql
            .slice(
                openToken.end - this.statement.start,
                closeToken.start - this.statement.start,
            )
            .trim()
    }

    /** Source text of tokens from `startPos` up to (not including) the current one. */
    rawFrom(startPos: number): string {
        const first = this.tokens[startPos]
        const last = this.tokens[this.pos - 1]
        if (!first || !last) return ""
        return this.statement.sql
            .slice(
                first.start - this.statement.start,
                last.end - this.statement.start,
            )
            .trim()
    }

    private sliceFrom(absoluteStart: number): string {
        return this.statement.sql
            .slice(absoluteStart - this.statement.start)
            .trim()
    }

    /**
     * Skips to the next top-level comma or end of statement.
     *
     * Brackets count as well as parentheses: array literals and subscripts are lexed
     * as punctuation, so tracking only `()` truncated predicates like
     * `WHERE tags && ARRAY['x','y']` at the comma inside the array.
     */
    skipToTopLevelComma(): void {
        let depth = 0
        while (!this.done) {
            const token = this.peek()!
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
            else if (
                token.kind === "punct" &&
                token.value === "," &&
                depth === 0
            )
                return
            this.pos += 1
        }
    }

    /** Consumes tokens up to the next top-level comma, returning their source text. */
    takeUntilTopLevelComma(): string {
        const start = this.pos
        this.skipToTopLevelComma()
        return this.rawFrom(start)
    }
}
