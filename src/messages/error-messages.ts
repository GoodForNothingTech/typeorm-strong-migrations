import type { CheckKey } from "../checks/keys"
import { HEADERS } from "../errors"

/**
 * Ported from strong_migrations' error_messages.rb, retargeted to TypeORM.
 *
 * Interpolation is `{{name}}` rather than Ruby's `%{name}`: no `%`-escaping pass
 * (the gem needs one because a message contains a literal "100%"), and no
 * collision with `${}` when someone pastes a message into a template literal.
 */

/**
 * TypeORM rejects any migration that sets `transaction` at all — including `true` —
 * while `migrationsTransactionMode` is "all", which is the default. So advising
 * `transaction = false` without this note sends people straight into
 * ForbiddenTransactionModeOverrideError with no idea we caused it.
 */
export const TRANSACTION_NOTE = `\`transaction = false\` requires \`migrationsTransactionMode: "each"\` (or "none") in
your DataSource options. With the default ("all"), TypeORM refuses to run any
migration that overrides the transaction mode. For a single run without changing
your DataSource, pass the mode on the command line:

    typeorm migration:run -d src/data-source.ts -t each`

/**
 * TypeORM's DDL builders have no NOT VALID and `createUniqueConstraint` has no
 * USING INDEX (verified: zero occurrences in the TypeORM source), so the safe
 * forms have to be written as raw SQL.
 */
const RAW_SQL_NOTE = (method: string, missing: string): string =>
    `TypeORM's ${method} has no ${missing} option, so the safe form is written as raw SQL.`

export const ERROR_MESSAGES: Readonly<Record<CheckKey, string>> = {
    // ── columns ──────────────────────────────────────────────────────────────

    addColumnDefault: `Adding a column with a {{defaultType}} default blocks {{rewriteBlocks}} while the
entire table is rewritten. Instead, add the column without a default value, then
change the default.

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        {{addCommand}}
        {{changeCommand}}
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        {{removeCommand}}
    }
}

Then backfill the existing rows in a separate migration with \`transaction = false\`.

export class Backfill{{baseName}}{{nextTimestamp}} implements MigrationInterface {
    public transaction = false

    public async up(queryRunner: QueryRunner): Promise<void> {
        {{code}}
    }

    public async down(): Promise<void> {}
}

${TRANSACTION_NOTE}`,

    addColumnDefaultExpression: `Strong Migrations cannot determine whether the default expression {{default}} is
volatile. TypeORM passes column defaults straight through to SQL, so an expression
default may rewrite the entire table.

If it is volatile, add the column without a default value, then change the default.

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        {{addCommand}}
        {{changeCommand}}
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        {{removeCommand}}
    }
}

Then backfill the existing rows in a separate migration with \`transaction = false\`.

Otherwise, wrap this step in safetyAssured(...).

${TRANSACTION_NOTE}`,

    addColumnJson: `There's no equality operator for the json column type, which can cause errors for
existing SELECT DISTINCT queries in your application. Use jsonb instead.

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        {{command}}
    }

    public async down(): Promise<void> {}
}`,

    addColumnGeneratedStored: `Adding a stored generated column blocks {{rewriteBlocks}} while the entire table is
rewritten.

A virtual generated column is computed on read and is safe to add. If you need the
value materialized, add a plain column and populate it from application code or a
trigger.`,

    addColumnAutoIncrementing: `Adding an auto-incrementing column blocks {{rewriteBlocks}} while the entire table is
rewritten.{{append}}

A safer approach is to create a new table and migrate the data, as you would when
renaming a table.`,

    changeColumn: `Changing the type of an existing column blocks {{rewriteBlocks}}
while the entire table is rewritten. A safer approach is to:

1. Create a new column
2. Write to both columns
3. Backfill data from the old column to the new column
4. Move reads from the old column to the new column
5. Stop writing to the old column
6. Drop the old column`,

    changeColumnWithNotNull: `Changing the type is safe, but setting NOT NULL is not.`,

    changeColumnConstraint: `Changing the type of a column that has check constraints blocks reads and writes
while every row is checked. Drop the check constraints on the column before
changing the type and add them back afterwards.

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        {{changeColumnCode}}
    }

    public async down(): Promise<void> {}
}

export class Validate{{baseName}}{{nextTimestamp}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        {{validateConstraintCode}}
    }

    public async down(): Promise<void> {}
}

${RAW_SQL_NOTE("createCheckConstraint()", "NOT VALID")}`,

    changeColumnNullPostgres: `Setting NOT NULL on an existing column blocks reads and writes while every row is
checked. Instead, add a check constraint and validate it in a separate migration.

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        {{addConstraintCode}}
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        {{removeConstraintCode}}
    }
}

export class Validate{{baseName}}{{nextTimestamp}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        {{validateConstraintCode}}
    }

    public async down(): Promise<void> {}
}

${RAW_SQL_NOTE("createCheckConstraint()", "NOT VALID")}`,

    changeColumnNullMysql: `Setting NOT NULL on an existing column is not safe without strict mode enabled.`,

    changeColumnDefault: `Changing a column default in a migration leaves the entity out of sync: the next
\`migration:generate\` will emit a migration reverting it. Update the @Column
decorator to match.

@Entity()
export class {{entity}} {
    @Column({ default: {{default}} })
    {{property}}
}`,

    dropColumn: `TypeORM builds explicit SELECT column lists from entity metadata, so any running
code whose entity still declares {{columns}} will error as soon as the column is
dropped. Remove it from the entity and deploy that first.

@Entity()
export class {{entity}} {
    // delete this:
    {{code}}
}

Deploy the code, then wrap this step in safetyAssured(...).

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await safetyAssured(() => {{command}})
    }

    public async down(): Promise<void> {}
}`,

    renameColumn: `Renaming a column that's in use will cause errors
in your application. A safer approach is to:

1. Create a new column
2. Write to both columns
3. Backfill data from the old column to the new column
4. Move reads from the old column to the new column
5. Stop writing to the old column
6. Drop the old column`,

    // ── tables / schemas / types ────────────────────────────────────────────

    dropTable: `Dropping a table that's in use will cause errors in your application, and the data
cannot be recovered. Remove the {{entity}} entity and every reference to it, deploy
that, then wrap this step in safetyAssured(...).

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await safetyAssured(() => {{command}})
    }

    public async down(): Promise<void> {}
}`,

    renameTable: `Renaming a table that's in use will cause errors
in your application. A safer approach is to:

1. Create a new table. Don't forget to recreate indexes from the old table
2. Write to both tables
3. Backfill data from the old table to the new table
4. Move reads from the old table to the new table
5. Stop writing to the old table
6. Drop the old table`,

    renameSchema: `Renaming a schema that's in use will cause errors
in your application. A safer approach is to:

1. Create a new schema
2. Write to both schemas
3. Backfill data from the old schema to the new schema
4. Move reads from the old schema to the new schema
5. Stop writing to the old schema
6. Drop the old schema`,

    renameEnumValue: `Renaming an enum value that's in use will cause errors
in your application. A safer approach is to:

1. Add a new enum value before or after the old value
2. Update application code to handle both values and write the new value
3. Backfill data from the old value to the new value

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        {{command}}
    }

    public async down(): Promise<void> {}
}`,

    // ── indexes ──────────────────────────────────────────────────────────────

    createIndex: `Adding an index non-concurrently blocks writes. Instead, use:

export class {{migrationName}} implements MigrationInterface {
    public transaction = false

    public async up(queryRunner: QueryRunner): Promise<void> {
        {{command}}
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        {{downCommand}}
    }
}

${TRANSACTION_NOTE}`,

    dropIndex: `Removing an index non-concurrently blocks writes. Instead, use:

export class {{migrationName}} implements MigrationInterface {
    public transaction = false

    public async up(queryRunner: QueryRunner): Promise<void> {
        {{command}}
    }

    public async down(): Promise<void> {}
}

${TRANSACTION_NOTE}`,

    createIndexColumns: `Adding a non-unique index with more than three columns rarely improves performance.
Instead, start an index with columns that narrow down the results the most.`,

    createIndexCorruption: `Adding an index concurrently can cause silent data corruption in Postgres 14.0 to 14.3.
Upgrade Postgres before adding new indexes, or wrap this step in safetyAssured(...)
to accept the risk.`,

    concurrentIndexInTransaction: `Postgres cannot create or drop an index concurrently inside a transaction, and this
migration is running in one.{{cause}}

{{remedy}}`,

    // ── constraints ──────────────────────────────────────────────────────────

    createForeignKey: `Adding a foreign key blocks writes on both tables. Instead,
add the foreign key without validating existing rows,
then validate them in a separate migration.

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        {{addForeignKeyCode}}
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        {{removeForeignKeyCode}}
    }
}

export class Validate{{baseName}}{{nextTimestamp}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        {{validateForeignKeyCode}}
    }

    public async down(): Promise<void> {}
}

${RAW_SQL_NOTE("createForeignKey()", "NOT VALID")}`,

    createForeignKeyMysql: `Adding a foreign key blocks writes on both tables. If you are 100% sure
all rows are valid and migrations do not use a connection pooler,
you can add the foreign key without validating existing rows.

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await safetyAssured(async () => {
            await queryRunner.query("SET SESSION foreign_key_checks = 0")
            try {
                {{addForeignKeyCode}}
            } finally {
                await queryRunner.query("SET SESSION foreign_key_checks = 1")
            }
        })
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        {{removeForeignKeyCode}}
    }
}`,

    validateForeignKey: `Validating a foreign key while writes are blocked is dangerous.
Set \`transaction = false\` on this migration, or move the validation to a
separate migration.

${TRANSACTION_NOTE}`,

    createCheckConstraint: `Adding a check constraint blocks reads and writes while every row is checked.
Instead, add the check constraint without validating existing rows,
then validate them in a separate migration.

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        {{addCheckConstraintCode}}
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        {{removeCheckConstraintCode}}
    }
}

export class Validate{{baseName}}{{nextTimestamp}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        {{validateCheckConstraintCode}}
    }

    public async down(): Promise<void> {}
}

${RAW_SQL_NOTE("createCheckConstraint()", "NOT VALID")}`,

    createCheckConstraintMysql: `Adding a check constraint to an existing table is not safe with your database engine.`,

    validateCheckConstraint: `Validating a check constraint while writes are blocked is dangerous.
Set \`transaction = false\` on this migration, or move the validation to a
separate migration.

${TRANSACTION_NOTE}`,

    createUniqueConstraint: `Adding a unique constraint creates a unique index, which blocks reads and writes.
Instead, create a unique index concurrently, then use it for the constraint.

export class {{migrationName}} implements MigrationInterface {
    public transaction = false

    public async up(queryRunner: QueryRunner): Promise<void> {
        {{indexCommand}}
        {{constraintCommand}}
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        {{removeCommand}}
    }
}

${TRANSACTION_NOTE}

${RAW_SQL_NOTE("createUniqueConstraint()", "USING INDEX")}`,

    createExclusionConstraint: `Adding an exclusion constraint blocks reads and writes while every row is checked.

Exclusion constraints cannot be added NOT VALID, so there is no safe way to add one
to a table that is in use. Create the table with the constraint, or accept the lock
and wrap this step in safetyAssured(...).`,

    // ── data ─────────────────────────────────────────────────────────────────

    backfill: `This statement updates or deletes every row in {{tableName}}:

    {{sql}}

That runs as one long transaction, which holds row locks for its whole duration and
can cause downtime on a large table. Backfill in batches instead.

export class {{migrationName}} implements MigrationInterface {
    public transaction = false

    public async up(queryRunner: QueryRunner): Promise<void> {
        {{code}}
    }

    public async down(): Promise<void> {}
}

${TRANSACTION_NOTE}`,

    truncate: `TRUNCATE removes every row in {{tableName}} and cannot be undone.

It also takes an ACCESS EXCLUSIVE lock, so reads block for its duration, and on
MySQL and MariaDB it commits implicitly — which silently ends the migration's
transaction and leaves earlier statements committed even if a later one fails.

If emptying the table is intended, wrap this step in safetyAssured(...).

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await safetyAssured(() => {{command}})
    }

    public async down(): Promise<void> {}
}`,

    createPrimaryKey: `Adding a primary key to an existing table blocks {{rewriteBlocks}}: it builds a
unique index over every row and sets the columns NOT NULL, both under an
ACCESS EXCLUSIVE lock.

Instead, build the unique index concurrently first, then adopt it. Postgres can
attach an existing index without rescanning the table.

export class {{migrationName}} implements MigrationInterface {
    public transaction = false

    public async up(queryRunner: QueryRunner): Promise<void> {
        {{notNullCommand}}
        {{indexCommand}}
        {{constraintCommand}}
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        {{removeCommand}}
    }
}

Each column must already be NOT NULL before the key is added — see the
changeColumnNull guidance for doing that without a blocking scan.

${TRANSACTION_NOTE}`,

    // ── destructive ──────────────────────────────────────────────────────────

    clearDatabase: `clearDatabase() drops every table and view in {{database}}. There is no undo, and
nothing in the migration history records what was there.

This is a fixture-teardown helper, not a migration step. If you genuinely mean it,
name the tables you want gone so the intent is reviewable:

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await safetyAssured(async () => {
            await queryRunner.dropTable("one_specific_table")
        })
    }

    public async down(): Promise<void> {}
}`,

    dropSchema: `Dropping a schema destroys every table in it, and {{cascade}}There is no undo.

Any running code still querying those tables fails immediately. Remove the entities
and deploy that first, then drop the schema in a later migration wrapped in
safetyAssured(...).

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await safetyAssured(() => queryRunner.dropSchema({{schema}}, true, true))
    }

    public async down(): Promise<void> {}
}`,

    dropDatabase: `Dropping a database destroys everything in it. There is no undo, and a migration is
an unusual place to do it — the connection you are running through generally lives in
the database being dropped.

If this is intentional, wrap it in safetyAssured(...).`,

    dropView: `Dropping a view breaks every query that reads from it, exactly as dropping a table
would. Remove the code that selects from {{viewName}} and deploy that first.

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await safetyAssured(() => queryRunner.dropView({{viewName}}))
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // recreate the view here so the migration is reversible
    }
}`,

    // ── heavy operations ─────────────────────────────────────────────────────

    tableRewrite: `{{clause}} rebuilds the entire {{tableName}} table and blocks {{rewriteBlocks}} for the
whole rebuild. On a large table that is an outage, not a pause.{{append}}

Use an online schema-change tool — pt-online-schema-change or gh-ost on MySQL — or
run it during a maintenance window and wrap this step in safetyAssured(...).`,

    vacuumFull: `VACUUM FULL takes an ACCESS EXCLUSIVE lock on {{tableName}} and rewrites the whole
table, so reads and writes both block until it finishes. It also needs enough free
disk for a second copy of the table.

Plain VACUUM reclaims space without the lock and is what you almost always want:

export class {{migrationName}} implements MigrationInterface {
    public transaction = false

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(\`VACUUM {{tableName}}\`)
    }

    public async down(): Promise<void> {}
}

If you need the space back immediately, pg_repack does it without the exclusive lock.

${TRANSACTION_NOTE}`,

    disableTrigger: `Disabling triggers on {{tableName}} also disables foreign key enforcement, because
Postgres implements foreign keys as triggers. Rows written while they are off are
never validated, and re-enabling does not re-check them — so this can leave
permanently inconsistent data behind.

If you are disabling triggers to speed up a backfill, batch the backfill instead and
leave enforcement on. If you genuinely need them off, wrap this step in
safetyAssured(...) and re-validate afterwards.`,

    flushTables: `FLUSH TABLES WITH READ LOCK takes a global read lock: every write to every table on
the server blocks until it is released. It is a backup primitive, not a migration
step, and holding it inside a migration stalls the whole application.

If you need a consistent snapshot, take it from a replica or use the backup tool's
own locking.`,

    insertSelect: `This statement writes as many rows as the SELECT returns, in one transaction:

    {{sql}}

Like an unbounded UPDATE, it holds locks for its whole duration and can cause
downtime on a large source table. Copy in batches instead.

export class {{migrationName}} implements MigrationInterface {
    public transaction = false

    public async up(queryRunner: QueryRunner): Promise<void> {
        {{code}}
    }

    public async down(): Promise<void> {}
}

${TRANSACTION_NOTE}`,

    // ── MySQL DDL options ────────────────────────────────────────────────────

    copyAlgorithm: `Using the COPY algorithm blocks writes. Instead, use:

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        {{command}}
    }

    public async down(): Promise<void> {}
}`,

    lockOption: `Using {{lockType}} locking blocks {{lockBlocks}}. Instead, use:

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        {{command}}
    }

    public async down(): Promise<void> {}
}`,

    // ── TypeORM-specific ─────────────────────────────────────────────────────

    transactionMode: `{{migrationName}} sets \`transaction = {{declared}}\`, but this DataSource has
\`migrationsTransactionMode: "{{mode}}"\`. TypeORM refuses to run any migration that
overrides the transaction mode unless the mode is "each" or "none".

Set it in your DataSource options:

export const AppDataSource = new DataSource({
    // ...
    migrationsTransactionMode: "each",
})

With "each", every migration runs in its own transaction and an individual migration
can opt out with \`transaction = false\`. Or pass it for a single run:

    typeorm migration:run -d src/data-source.ts -t each`,

    partialParse: `Strong Migrations understood part of this statement but not all of it, so some
checks may not have run:

    {{sql}}

Unrecognized: {{clauses}}

Because the statement is only partly understood, no rewrite is offered for it — a
suggested "safe version" rebuilt from an incomplete reading could differ from what you
actually asked for.

Review it yourself and wrap it in safetyAssured(...), or report the unrecognized
clause so the analyzer can cover it.`,

    rawQuery: `Strong Migrations could not determine what this statement does, so cannot help you
here:

    {{sql}}

Please make really sure that what you're doing is safe before proceeding, then wrap
it in safetyAssured(...).

export class {{migrationName}} implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await safetyAssured(async () => {
            await queryRunner.query(\`...\`)
        })
    }

    public async down(): Promise<void> {}
}

If this statement is something Strong Migrations should understand, please report it
so the analyzer can cover it.`,
}

/** The banner header each key renders under. */
export const MESSAGE_HEADERS: Readonly<Partial<Record<CheckKey, string>>> = {
    createIndexColumns: HEADERS.bestPractice,
    rawQuery: HEADERS.possiblyDangerous,
    partialParse: HEADERS.possiblyDangerous,
    transactionMode: HEADERS.configuration,
    changeColumnDefault: HEADERS.bestPractice,
}

export function headerFor(key: CheckKey): string {
    return MESSAGE_HEADERS[key] ?? HEADERS.dangerous
}
