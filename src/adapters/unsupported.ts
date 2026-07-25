import type { QueryRunner } from "typeorm"
import type { Dialect } from "../operations/types"
import { AbstractAdapter } from "./abstract"

/**
 * Every driver outside Postgres/MySQL/MariaDB. Reports one warning and then does
 * nothing — no checks, and crucially no timeout statements, which would be
 * invalid SQL against e.g. SQLite.
 */
export class UnsupportedAdapter extends AbstractAdapter {
    readonly key = "unsupported" as const
    readonly name: string
    // Only used for identifier quoting in the rare message that reaches here.
    readonly dialect: Dialect = "postgres"
    override readonly supported = false

    constructor(queryRunner: QueryRunner, driverType: string) {
        super(queryRunner)
        this.name = driverType
    }

    warning(dataSourceName: string): string {
        return (
            `[strong-migrations] Unsupported driver: ${this.name}. ` +
            `Migrations will run unchecked. Use skipDataSource(${JSON.stringify(dataSourceName)}) ` +
            `to silence this warning.`
        )
    }
}
