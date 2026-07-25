import type { OperationKind } from "../operations/types"
import { CHANGE_COLUMN_CHECKS } from "./change-column-checks"
import { COLUMN_CHECKS } from "./column-checks"
import { CONSTRAINT_CHECKS } from "./constraint-checks"
import { DESTRUCTIVE_CHECKS } from "./destructive-checks"
import { INDEX_CHECKS } from "./index-checks"
import { MISC_CHECKS } from "./misc-checks"
import type { Check } from "./types"

export const ALL_CHECKS: readonly Check[] = [
    ...INDEX_CHECKS,
    ...COLUMN_CHECKS,
    ...CHANGE_COLUMN_CHECKS,
    ...CONSTRAINT_CHECKS,
    ...DESTRUCTIVE_CHECKS,
    ...MISC_CHECKS,
]

const BY_KIND = new Map<OperationKind, Check[]>()
for (const check of ALL_CHECKS) {
    for (const kind of check.kinds) {
        const existing = BY_KIND.get(kind)
        if (existing) existing.push(check)
        else BY_KIND.set(kind, [check])
    }
}

export function checksFor(kind: OperationKind): readonly Check[] {
    return BY_KIND.get(kind) ?? []
}
