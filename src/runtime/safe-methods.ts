import { supportsConcurrentTableIndex, TableIndexCtor } from "../compat/typeorm"
import type { CheckContext, CheckVerdict } from "../checks/types"
import { StrongMigrationsConfigError } from "../errors"
import type { Operation } from "../operations/types"
import { notNullConstraintName } from "../adapters/postgres"
import { quoteIdent, quoteTable, typeormTablePath } from "../util/sql"
import { currentChecker } from "./context"

/**
 * safeByDefault rewrites.
 *
 * These have to commit the ambient transaction, because CONCURRENTLY cannot run
 * inside one. That is only sound when each migration owns its own transaction:
 * under `migrationsTransactionMode: "all"` a mid-batch commit would also commit
 * every *other* migration's work, turning a failure halfway through into a
 * partially-applied schema. So the rewrite refuses under "all" rather than doing
 * something surprising.
 */
export function assertSafeByDefaultUsable(ctx: CheckContext): void {
    if (ctx.transactionMode === "all") {
        throw new StrongMigrationsConfigError(
            "safeByDefault needs to commit the migration's transaction so it can run " +
                'CREATE INDEX CONCURRENTLY, but migrationsTransactionMode is "all", where a ' +
                "single transaction spans every pending migration. Committing there would also " +
                'commit other migrations\' work. Set migrationsTransactionMode: "each" (or ' +
                '"none"), or turn off safeByDefault.',
        )
    }
}

/**
 * Commits the open transaction so a concurrent operation can run, and records that
 * we did. `finalizeMigration` re-opens one afterwards so TypeORM's own commit does
 * not fail with TransactionNotStartedError.
 */
async function disableTransaction(ctx: CheckContext): Promise<void> {
    const checker = currentChecker()
    if (!ctx.queryRunner.isTransactionActive) return
    await ctx.queryRunner.commitTransaction()
    if (checker) checker.state.transactionDisabled = true
}

export function rewriteConcurrentIndex(
    op: Extract<Operation, { kind: "createIndex" }>,
    ctx: CheckContext,
): CheckVerdict | undefined {
    if (ctx.dialect !== "postgres") return undefined
    // A rewrite replaces the user's statement with one rebuilt from our model, so it
    // is only sound when the model is complete. Refusing here degrades to the plain
    // error, which quotes their SQL and lets them fix it themselves.
    if (!canRebuildIndex(op)) return undefined
    assertSafeByDefaultUsable(ctx)

    return {
        type: "rewrite",
        describe: `creating index ${op.name ?? ""} on ${op.table.name} concurrently`,
        run: async (queryRunner) => {
            await disableTransaction(ctx)
            const IndexCtor = TableIndexCtor()
            if (
                op.source === "typed" &&
                IndexCtor &&
                supportsConcurrentTableIndex()
            ) {
                await queryRunner.createIndex(
                    typeormTablePath(op.table),
                    new IndexCtor({
                        name: op.name,
                        columnNames: op.columns.map(
                            (column) => column.name ?? "",
                        ),
                        isUnique: op.unique,
                        where: op.where,
                        isConcurrent: true,
                    }),
                )
                return
            }
            await queryRunner.query(concurrentIndexSql(op))
        },
    }
}

/**
 * Whether an index statement can be faithfully reconstructed.
 *
 * `partial` means the parser met a clause it does not model. `direction` is parsed but
 * has no emitter, so rebuilding a `(a DESC)` index would quietly produce an ASC one.
 * Both cases must fall back rather than emit a subtly different index.
 */
export function canRebuildIndex(
    op: Extract<Operation, { kind: "createIndex" }>,
): boolean {
    if (op.partial) return false
    if (op.columns.some((column) => column.direction)) return false
    return true
}

export function rewriteConcurrentIndexDrop(
    op: Extract<Operation, { kind: "dropIndex" }>,
    ctx: CheckContext,
): CheckVerdict | undefined {
    if (ctx.dialect !== "postgres") return undefined
    assertSafeByDefaultUsable(ctx)

    return {
        type: "rewrite",
        describe: `dropping index ${op.name} concurrently`,
        run: async (queryRunner) => {
            await disableTransaction(ctx)
            const qualified =
                op.table?.schema !== undefined
                    ? `${quoteIdent(op.table.schema, "postgres")}.${quoteIdent(op.name, "postgres")}`
                    : quoteIdent(op.name, "postgres")
            await queryRunner.query(`DROP INDEX CONCURRENTLY ${qualified}`)
        },
    }
}

/** Adds the foreign key NOT VALID, then validates it outside the lock. */
export function rewriteForeignKeyNotValid(
    op: Extract<Operation, { kind: "createForeignKey" }>,
    ctx: CheckContext,
): CheckVerdict | undefined {
    if (!ctx.adapter.supportsNotValidConstraints) return undefined
    // The rewrite rebuilds the constraint from the parsed model, so an unmodelled
    // tail — ON DELETE CASCADE, DEFERRABLE — would be silently dropped and the
    // constraint would behave differently from the one asked for.
    if (op.partial) return undefined
    const name = op.name ?? `FK_${op.table.name}_${op.columns.join("_")}`

    return {
        type: "rewrite",
        describe: `adding foreign key ${name} without validating existing rows`,
        run: async (queryRunner) => {
            const columns = op.columns
                .map((column) => quoteIdent(column, "postgres"))
                .join(", ")
            const referenced = op.referencedColumns
                .map((column) => quoteIdent(column, "postgres"))
                .join(", ")
            await queryRunner.query(
                `ALTER TABLE ${quoteTable(op.table, "postgres")} ADD CONSTRAINT ` +
                    `${quoteIdent(name, "postgres")} FOREIGN KEY (${columns}) ` +
                    `REFERENCES ${quoteTable(op.referencedTable, "postgres")} (${referenced}) NOT VALID`,
            )
            // Validating takes only a SHARE UPDATE EXCLUSIVE lock, so writes continue.
            await queryRunner.query(
                `ALTER TABLE ${quoteTable(op.table, "postgres")} VALIDATE CONSTRAINT ${quoteIdent(name, "postgres")}`,
            )
        },
    }
}

export function rewriteCheckConstraintNotValid(
    op: Extract<Operation, { kind: "createCheckConstraint" }>,
    ctx: CheckContext,
): CheckVerdict | undefined {
    if (!ctx.adapter.supportsNotValidConstraints) return undefined
    if (op.partial) return undefined
    const name = op.name ?? `CHK_${op.table.name}`

    return {
        type: "rewrite",
        describe: `adding check constraint ${name} without validating existing rows`,
        run: async (queryRunner) => {
            await queryRunner.query(
                `ALTER TABLE ${quoteTable(op.table, "postgres")} ADD CONSTRAINT ` +
                    `${quoteIdent(name, "postgres")} CHECK (${op.expression}) NOT VALID`,
            )
            await queryRunner.query(
                `ALTER TABLE ${quoteTable(op.table, "postgres")} VALIDATE CONSTRAINT ${quoteIdent(name, "postgres")}`,
            )
        },
    }
}

/**
 * The full NOT NULL dance: add a NOT VALID check constraint, validate it without
 * blocking writes, then set NOT NULL (which Postgres can do cheaply once a proving
 * constraint exists), then drop the constraint.
 */
export function rewriteSetNotNull(
    op: Extract<Operation, { kind: "changeColumnNull" }>,
    ctx: CheckContext,
): CheckVerdict | undefined {
    if (ctx.dialect !== "postgres") return undefined
    const name = notNullConstraintName(
        op.table,
        op.column,
        ctx.adapter.maxConstraintNameLength,
    )

    return {
        type: "rewrite",
        describe: `setting ${op.table.name}.${op.column} NOT NULL without a full table scan under lock`,
        run: async (queryRunner) => {
            const table = quoteTable(op.table, "postgres")
            const column = quoteIdent(op.column, "postgres")
            const constraint = quoteIdent(name, "postgres")
            await queryRunner.query(
                `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} CHECK (${column} IS NOT NULL) NOT VALID`,
            )
            await queryRunner.query(
                `ALTER TABLE ${table} VALIDATE CONSTRAINT ${constraint}`,
            )
            await queryRunner.query(
                `ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`,
            )
            await queryRunner.query(
                `ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`,
            )
        },
    }
}

function concurrentIndexSql(
    op: Extract<Operation, { kind: "createIndex" }>,
): string {
    const unique = op.unique ? "UNIQUE " : ""
    const using = op.using ? ` USING ${op.using}` : ""
    // INCLUDE and NULLS NOT DISTINCT both change what the index *is*, so a rebuild
    // that omitted them would silently produce a different index.
    const include = op.include?.length
        ? ` INCLUDE (${op.include.map((column) => quoteIdent(column, "postgres")).join(", ")})`
        : ""
    const nullsNotDistinct = op.nullsNotDistinct ? " NULLS NOT DISTINCT" : ""
    const where = op.where ? ` WHERE ${op.where}` : ""
    const name = op.name ? `${quoteIdent(op.name, "postgres")} ` : ""
    const columns = op.columns
        .map((column) =>
            column.name
                ? quoteIdent(column.name, "postgres")
                : (column.expression ?? ""),
        )
        .join(", ")
    return (
        `CREATE ${unique}INDEX CONCURRENTLY ${name}ON ${quoteTable(op.table, "postgres")}` +
        `${using} (${columns})${include}${nullsNotDistinct}${where}`
    )
}

/**
 * Re-opens a transaction if a rewrite committed the one TypeORM opened, so
 * `MigrationExecutor`'s own commit does not fail. This mirrors what the gem does at
 * the tail of `Migration#migrate`.
 */
export async function finalizeMigration(ctx: {
    queryRunner: CheckContext["queryRunner"]
    transactionDisabled: boolean
}): Promise<void> {
    if (!ctx.transactionDisabled) return
    if (ctx.queryRunner.isTransactionActive) return
    await ctx.queryRunner.startTransaction()
}
