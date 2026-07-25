import type { CheckKey } from "../checks/keys"
import type { ResolvedConfig } from "../config"
import { ERROR_MESSAGES } from "./error-messages"

const PLACEHOLDER = /\{\{(\w+)\}\}/g

/**
 * Interpolates `{{name}}` placeholders. A placeholder with no value renders empty
 * — several messages carry optional fragments such as `{{append}}` — and the
 * resulting blank runs are collapsed so the output never looks half-rendered.
 */
export function interpolate(
    template: string,
    vars: Record<string, string>,
): string {
    const filled = template.replace(
        PLACEHOLDER,
        (_match, name: string) => vars[name] ?? "",
    )
    return filled
        .split("\n")
        .map((line) => line.replace(/[ \t]+$/, ""))
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim()
}

export function messageTemplate(
    key: CheckKey,
    config?: ResolvedConfig,
): string {
    return config?.errorMessages[key] ?? ERROR_MESSAGES[key]
}

export function renderMessage(
    key: CheckKey,
    vars: Record<string, string> = {},
    config?: ResolvedConfig,
): string {
    return interpolate(messageTemplate(key, config), vars)
}

/**
 * TypeORM requires a 13-digit timestamp suffix on every migration class name
 * (`MigrationExecutor.getMigrations` parses `name.slice(-13)` and throws otherwise).
 * Follow-up migrations rendered in a message therefore need their own valid,
 * non-colliding name.
 */
export function splitMigrationName(migrationName: string): {
    baseName: string
    timestamp?: number
    nextTimestamp: string
} {
    const suffix = migrationName.slice(-13)
    const parsed = Number.parseInt(suffix, 10)
    if (
        suffix.length === 13 &&
        /^\d{13}$/.test(suffix) &&
        !Number.isNaN(parsed)
    ) {
        return {
            baseName: migrationName.slice(0, -13),
            timestamp: parsed,
            nextTimestamp: String(parsed + 1),
        }
    }
    return { baseName: migrationName, nextTimestamp: String(Date.now()) }
}

/** Variables injected into every message regardless of key. */
export function baseVars(migrationName: string): Record<string, string> {
    const { baseName, nextTimestamp } = splitMigrationName(migrationName)
    return { migrationName, baseName, nextTimestamp }
}

/** Indents continuation lines so multi-line snippets sit correctly in a template. */
export function indentBlock(text: string, spaces: number): string {
    const pad = " ".repeat(spaces)
    return text
        .split("\n")
        .map((line, index) =>
            index === 0 || line.length === 0 ? line : pad + line,
        )
        .join("\n")
}
