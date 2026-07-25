import type { Operation, TableRef } from "../operations/types"
import { sameTable } from "../operations/types"

/**
 * Per-migration bookkeeping.
 *
 * The important part is `newTables` / `newColumns`: locking a table nobody can see
 * yet is harmless, so an index added to a table created earlier in the same
 * migration is safe. The gem tracks the same two sets for the same reason.
 */
export class MigrationState {
    private readonly newTables: TableRef[] = []
    private readonly newColumns: Array<{ table: TableRef; column: string }> = []

    timeoutsSet = false
    lockTimeoutChecked = false
    adapterChecked = false
    versionChecked = false
    /** The migration committed the ambient transaction itself. */
    committed = false
    /** safeByDefault committed the transaction to run a concurrent operation. */
    transactionDisabled = false
    skipRetries = false

    recordTable(table: TableRef): void {
        if (!this.isNewTable(table)) this.newTables.push(table)
    }

    recordColumn(table: TableRef, column: string): void {
        if (!this.isNewColumn(table, column))
            this.newColumns.push({ table, column })
    }

    isNewTable(table: TableRef): boolean {
        return this.newTables.some((known) => sameTable(known, table))
    }

    isNewColumn(table: TableRef, column: string): boolean {
        if (this.isNewTable(table)) return true
        return this.newColumns.some(
            (known) =>
                sameTable(known.table, table) &&
                known.column.toLowerCase() === column.toLowerCase(),
        )
    }

    /** Applied after checks pass, so an operation never exempts itself. */
    record(op: Operation): void {
        switch (op.kind) {
            case "createTable":
                this.recordTable(op.table)
                for (const column of op.columns)
                    this.recordColumn(op.table, column.name)
                break
            case "addColumn":
                this.recordColumn(op.table, op.column.name)
                break
            default:
                break
        }
    }
}
