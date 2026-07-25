import {
    createIndexConcurrently,
    dropIndexConcurrently,
    suggestIndexName,
} from "../messages/commands"
import {
    canRebuildIndex,
    rewriteConcurrentIndex,
    rewriteConcurrentIndexDrop,
} from "../runtime/safe-methods"
import type { Check, CheckContext, CheckVerdict } from "./types"
import { unsafe } from "./types"

/**
 * Adding an index without CONCURRENTLY takes a lock that blocks writes for the
 * whole build. Postgres only: MySQL 8's online DDL already allows concurrent DML
 * for index creation, which is why the gem does not flag it there either.
 */
export const createIndexCheck: Check = {
    keys: ["createIndex"],
    kinds: ["createIndex"],
    run(op, ctx) {
        if (op.kind !== "createIndex") return []
        if (ctx.dialect !== "postgres") return []
        if (op.concurrent) return []
        // A table created earlier in this migration is not visible to anyone else,
        // so locking it costs nothing.
        if (ctx.isNewTable(op.table)) return []

        if (ctx.config.safeByDefault) {
            const rewrite = rewriteConcurrentIndex(op, ctx)
            if (rewrite) return [rewrite]
        }

        const name = op.name ?? suggestIndexName(op.table, op.columns)
        // When the parse was lossy, advise adding CONCURRENTLY to the statement the
        // user wrote rather than printing one rebuilt from an incomplete model.
        const originalSql = canRebuildIndex(op) ? undefined : op.raw.sql

        return [
            unsafe("createIndex", {
                command: createIndexConcurrently(
                    op.table,
                    op.columns,
                    {
                        name,
                        unique: op.unique,
                        where: op.where,
                        using: op.using,
                        include: op.include,
                        nullsNotDistinct: op.nullsNotDistinct,
                        originalSql,
                    },
                    ctx.render,
                ),
                downCommand: dropIndexConcurrently(op.table, name, ctx.render),
            }),
        ]
    },
}

export const dropIndexCheck: Check = {
    keys: ["dropIndex"],
    kinds: ["dropIndex"],
    run(op, ctx) {
        if (op.kind !== "dropIndex") return []
        if (ctx.dialect !== "postgres") return []
        if (op.concurrent) return []
        if (op.table && ctx.isNewTable(op.table)) return []

        if (ctx.config.safeByDefault) {
            const rewrite = rewriteConcurrentIndexDrop(op, ctx)
            if (rewrite) return [rewrite]
        }

        return [
            unsafe("dropIndex", {
                command: dropIndexConcurrently(op.table, op.name, ctx.render),
            }),
        ]
    },
}

/** Advisory, not a safety issue — hence the "Best practice" header. */
export const createIndexColumnsCheck: Check = {
    keys: ["createIndexColumns"],
    kinds: ["createIndex"],
    run(op) {
        if (op.kind !== "createIndex") return []
        if (op.unique || op.columns.length <= 3) return []
        return [unsafe("createIndexColumns")]
    },
}

/**
 * Postgres 14.0-14.3 could silently corrupt an index built concurrently. Skipped in
 * development, where the local server version is not what production runs.
 */
export const createIndexCorruptionCheck: Check = {
    keys: ["createIndexCorruption"],
    kinds: ["createIndex"],
    run(op, ctx) {
        if (op.kind !== "createIndex" || !op.concurrent) return []
        if (!ctx.adapter.hasIndexCorruptionBug(ctx.config.developerEnv))
            return []
        return [unsafe("createIndexCorruption")]
    },
}

/**
 * Postgres refuses CONCURRENTLY inside a transaction, and its own error (25001)
 * says nothing about TypeORM's transaction modes. Worse, under the default "all"
 * mode the failure rolls back every migration in the batch. We know both the mode
 * and what the migration declared, so we can name the exact fix.
 */
export const concurrentIndexInTransactionCheck: Check = {
    keys: ["concurrentIndexInTransaction"],
    kinds: ["createIndex", "dropIndex"],
    run(op, ctx): CheckVerdict[] {
        if (op.kind !== "createIndex" && op.kind !== "dropIndex") return []
        if (!op.concurrent || ctx.dialect !== "postgres") return []
        if (!ctx.inTransaction) return []
        return [unsafe("concurrentIndexInTransaction", remedyVars(ctx))]
    },
}

function remedyVars(ctx: CheckContext): Record<string, string> {
    const declared = ctx.migration.declaredTransaction

    if (ctx.transactionMode === "all" && declared === undefined) {
        return {
            cause: ` This DataSource uses \`migrationsTransactionMode: "all"\`, which wraps every
pending migration in one transaction.`,
            remedy: `Two changes are needed, in this order:

1) Set \`migrationsTransactionMode: "each"\` (or "none") in your DataSource options.
   Under "all", TypeORM rejects any migration that opts out of transactions.

2) Add \`public transaction = false\` to ${ctx.migration.name}.

For a single run without changing your DataSource:

    typeorm migration:run -d src/data-source.ts -t each`,
        }
    }

    if (declared !== false) {
        return {
            cause: "",
            remedy: `Add \`public transaction = false\` to ${ctx.migration.name}:

export class ${ctx.migration.name} implements MigrationInterface {
    public transaction = false

    // ...
}`,
        }
    }

    return {
        cause: ` ${ctx.migration.name} already sets \`transaction = false\`, so the transaction
was opened by something else — most likely a \`startTransaction()\` call inside the
migration itself.`,
        remedy: `Remove the explicit \`startTransaction()\`, or move the concurrent operation
outside it.`,
    }
}

export const INDEX_CHECKS: Check[] = [
    createIndexCheck,
    dropIndexCheck,
    createIndexColumnsCheck,
    createIndexCorruptionCheck,
    concurrentIndexInTransactionCheck,
]
