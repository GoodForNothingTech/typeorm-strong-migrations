# TypeORM Strong Migrations

Catch unsafe TypeORM migrations in development.

```
=== Dangerous operation detected #strong_migrations ===

Adding an index non-concurrently blocks writes. Instead, use:

export class AddIndexOnUsersEmail1735689600000 implements MigrationInterface {
    public transaction = false

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_users_email" ON "users" ("email")`)
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX CONCURRENTLY "IDX_users_email"`)
    }
}

`transaction = false` requires `migrationsTransactionMode: "each"` (or "none") in
your DataSource options. With the default ("all"), TypeORM refuses to run any
migration that overrides the transaction mode. For a single run without changing
your DataSource, pass the mode on the command line:

    typeorm migration:run -d src/data-source.ts -t each
```

A port of the Rails gem [strong_migrations](https://github.com/ankane/strong_migrations)
to TypeORM. Same checks, same conditions, same version and dialect gating — retargeted
from ActiveRecord to TypeORM.

Supports **PostgreSQL**, **MySQL**, and **MariaDB**.

## Installation

```sh
npm install --save-dev typeorm-strong-migrations
```

Wrap your DataSource:

```ts
import "reflect-metadata"
import { DataSource } from "typeorm"
import { installStrongMigrations } from "typeorm-strong-migrations"

export const AppDataSource = installStrongMigrations(
    new DataSource({
        type: "postgres",
        url: process.env.DATABASE_URL,
        entities: ["src/entity/**/*.ts"],
        migrations: ["src/migration/**/*.ts"],

        // Required for any migration that sets `transaction = false`, which is
        // how CREATE INDEX CONCURRENTLY is run. With the default "all", TypeORM
        // rejects migrations that opt out of transactions.
        migrationsTransactionMode: "each",
    }),
    {
        // Existing migrations are treated as safe. Use your latest migration's
        // 13-digit timestamp suffix.
        startAfter: 1735689600000,

        lockTimeout: "10s",
        statementTimeout: "1h",
        autoAnalyze: true,
    },
)
```

`installStrongMigrations` returns the same DataSource, so it composes cleanly and the
TypeORM CLI still finds it.

### NestJS

Use `dataSourceFactory`, which Nest calls in place of constructing the DataSource itself:

```ts
TypeOrmModule.forRoot({
    type: "postgres",
    url: process.env.DATABASE_URL,
    autoLoadEntities: true,
    migrations: ["dist/migration/*.js"],
    migrationsTransactionMode: "each",
    dataSourceFactory: async (options) =>
        installStrongMigrations(new DataSource(options!), {
            startAfter: 1735689600000,
        }).initialize(),
})
```

If you also run migrations through the TypeORM CLI, call `installStrongMigrations` in
your CLI data-source file too. It is idempotent, so a shared helper is safe.

## How it works

`typeorm migration:generate` emits migration bodies made **entirely** of raw SQL:

```ts
await queryRunner.query(
    `ALTER TABLE "users" ADD "uuid" uuid NOT NULL DEFAULT gen_random_uuid()`,
)
```

There are no typed `addColumn` / `createIndex` calls to intercept. So this package
parses the SQL and runs the same checks against it that it runs against typed
`QueryRunner` calls — both normalize into one internal representation, and each check
is written once.

Statements it cannot interpret are reported rather than waved through:

| Statement                                                    | Behaviour     |
| ------------------------------------------------------------ | ------------- |
| Parsed, a check fires                                        | error         |
| Parsed, nothing fires                                        | silent        |
| Parsed with an unmodeled tail clause                         | warn          |
| DDL-shaped but unparseable (`DO $$ … $$`, `CREATE FUNCTION`) | error         |
| Not DDL (`SELECT`, `SET`, `COMMIT`)                          | silent        |
| `UPDATE`/`DELETE` with no `WHERE`                            | error         |
| TypeORM's own `migrations` / `typeorm_metadata` bookkeeping  | always silent |

## Checks

**All databases**

- adding a column with a volatile default
- removing a column
- changing a column's type, or setting NOT NULL alongside the change
- changing the type of a column that has check constraints
- renaming a column, table, or schema
- dropping a table, view, schema or database
- `clearDatabase()`, which drops every table
- adding a primary key to an existing table
- adding a stored generated column
- adding an auto-incrementing column
- adding a foreign key
- adding a check constraint
- `TRUNCATE`
- backfilling with an unbounded `UPDATE`, `DELETE` or `INSERT … SELECT`
- a full table rebuild (`ENGINE=`, `CONVERT TO CHARACTER SET`, `SET LOGGED`, …)
- executing SQL that cannot be analyzed, or that is only partly understood

**Postgres**

- adding an index non-concurrently
- removing an index non-concurrently (opt-in)
- adding a unique constraint
- adding an exclusion constraint
- adding a `json` column
- adding a `uuid` column with a volatile default
- setting `NOT NULL` on an existing column
- renaming an enum value
- validating a constraint while writes are blocked
- `CREATE INDEX CONCURRENTLY` inside a transaction
- `VACUUM FULL`
- `DISABLE TRIGGER`, which also disables foreign key enforcement
- index corruption on Postgres 14.0–14.3

**MySQL and MariaDB**

- setting `NOT NULL` without strict mode
- `ALGORITHM=COPY`
- `LOCK=SHARED` / `LOCK=EXCLUSIVE`
- `FLUSH TABLES WITH READ LOCK`, a global read lock

**Best practices**

- non-unique index with more than three columns

## Assuring safety

When you have reviewed an operation and want it to run anyway:

```ts
import { safetyAssured } from "typeorm-strong-migrations"

public async up(queryRunner: QueryRunner): Promise<void> {
    await safetyAssured(async () => {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "legacy_email"`)
    })
}
```

Or for a whole migration:

```ts
export class DropLegacy1735689600000 implements MigrationInterface {
    public readonly safetyAssured = true
    // ...
}
```

Or for specific checks only — narrower than the gem can express:

```ts
public readonly safetyAssured = ["dropColumn", "createIndex"] as const
```

Or for a single statement, with a marker comment that survives every layer:

```ts
await queryRunner.query(
    `/* strong-migrations:ignore */ ALTER TABLE "users" DROP COLUMN "x"`,
)
```

Or for an entire run: `SAFETY_ASSURED=1 typeorm migration:run -d src/data-source.ts`.

## CI linting

Check migration files without a database:

```sh
npx typeorm-strong-migrations check src/migration
```

Exits `1` when it finds something, and `2` for bad usage or a path that does not
exist — so a typo in a CI path fails loudly rather than passing green. Checks that
need live introspection (comparing a column's current type, for example) are skipped,
since there is nothing to introspect.

```
Usage: typeorm-strong-migrations check <path...> [options]

  -d, --dialect          postgres | mysql | mariadb. Default: postgres
      --config <path>    Config file. Otherwise strong-migrations.config.{ts,js,json}
                         is looked for by walking up from the working directory.
      --migrations-table Name of the migrations table, if not "migrations".
      --json             Emit findings as JSON.
  -v, --version          Print the version.

Exit codes: 0 no findings · 1 findings · 2 bad usage or a missing path
```

Configuration applies to the CLI as well as to the runtime, so a check can be
silenced in CI:

```json
// strong-migrations.config.json
{
    "startAfter": 1735689600000,
    "enabledChecks": { "createIndexColumns": false }
}
```

A `.ts` config needs a loader in the process (run the CLI through `tsx`), so for CI
a `.json` or `.js` file is usually simpler.

## Configuration

Every option, with its default:

| Option                  | Default                    | Notes                                                                                                                                                                        |
| ----------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `startAfter`            | `0`                        | Migrations at or below this 13-digit ms timestamp are treated as safe.                                                                                                       |
| `autoAnalyze`           | `false`                    | Run `ANALYZE` after creating an index.                                                                                                                                       |
| `checks`                | `[]`                       | Custom checks.                                                                                                                                                               |
| `errorMessages`         | `{}`                       | Override individual messages. Merged over the built-ins.                                                                                                                     |
| `targetVersion`         | —                          | Production server version. **Honored in development/test only.**                                                                                                             |
| `enabledChecks`         | all but two                | Merged over the defaults. `dropIndex` and `changeColumnDefault` ship off.                                                                                                    |
| `lockTimeout`           | `null`                     | e.g. `"10s"`. A bare number is milliseconds.                                                                                                                                 |
| `statementTimeout`      | `null`                     | e.g. `"1h"`.                                                                                                                                                                 |
| `transactionTimeout`    | `null`                     | Postgres 17+ only.                                                                                                                                                           |
| `lockTimeoutLimit`      | `"10s"` outside dev        | Warn-only.                                                                                                                                                                   |
| `checkDown`             | `false`                    | Also check `down()`.                                                                                                                                                         |
| `safeByDefault`         | `false`                    | Rewrite unsafe operations into their safe form.                                                                                                                              |
| `targetSqlMode`         | `null`                     | MySQL `sql_mode` to assume. Also tells the analyzer whether `ANSI_QUOTES` is in effect. Development/test only.                                                               |
| `lockTimeoutRetries`    | `0`                        | Statement-level only; a no-op inside a transaction.                                                                                                                          |
| `lockTimeoutRetryDelay` | `"10s"`                    |                                                                                                                                                                              |
| `skippedDataSources`    | `[]`                       |                                                                                                                                                                              |
| `removeInvalidIndexes`  | `false`                    | Postgres.                                                                                                                                                                    |
| `unknownSql`            | `"error"`                  | DDL the analyzer cannot interpret.                                                                                                                                           |
| `partialSql`            | `"warn"`                   | Statements parsed with a clause we do not model. No rewrite is offered for these — a "safe version" rebuilt from an incomplete reading could differ from what you asked for. |
| `env`                   | `NODE_ENV ?? "production"` | Overridable with `STRONG_MIGRATIONS_ENV`.                                                                                                                                    |

Config can also be set globally, before your DataSource is constructed:

```ts
import { configure, addCheck, disableCheck } from "typeorm-strong-migrations"

configure({ startAfter: 1735689600000 })
disableCheck("createIndexColumns")

addCheck(({ operations, stop }) => {
    for (const op of operations) {
        if (op.kind === "createIndex" && op.table.name === "events") {
            stop("No more indexes on the events table")
        }
    }
})
```

Per-DataSource config passed to `installStrongMigrations` wins over the global config.

### Environment detection

An unset `NODE_ENV` is treated as **production**. This inverts the usual Node
convention deliberately: if we cannot prove we are in development, checks should not
be weakened. Set `NODE_ENV`, `STRONG_MIGRATIONS_ENV`, or `{ env: "development" }`.

`targetVersion` and `targetSqlMode` are ignored outside development and test, so
production always checks against the server it is actually talking to.

## Coming from strong_migrations

Check keys are named after the TypeORM method rather than the Rails one, because that
is what you call:

```ts
disableCheck("createIndex") // add_index
disableCheck("dropColumn") // remove_column
```

The gem's snake_case names are accepted everywhere a key is, so a ported Ruby
initializer keeps working:

```ts
disableCheck("add_index") // resolves to createIndex
```

Other differences:

- Interpolation in custom messages is `{{name}}`, not `%{name}`.
- `enabledChecks` **merges** over the defaults instead of replacing them. In the gem,
  setting one key silently disables every other check.
- `alphabetize_schema` is gone — TypeORM has no schema dumper.
- `change_column_default` guarded Rails' `partial_inserts`, which has no TypeORM
  equivalent. The key still exists (so a ported config does not throw) but ships
  disabled and now reports entity drift rather than a correctness hazard.
- `add_reference` was a Rails macro. TypeORM users write the column, index, and
  foreign key separately, and each is already checked.
- Added: `dropTable`, `backfill`, `transactionMode`, and
  `concurrentIndexInTransaction`, which have no gem counterpart.

## Development

```sh
npm install
npm test                  # unit suite, no database
npm run db:up             # Postgres, MySQL, MariaDB in Docker
npm run test:integration  # against Postgres by default
ADAPTER=mysql npm run test:integration
```

If you already run Postgres or MySQL locally on the default port, the compose host
ports are overridable:

```sh
TSM_PG_PORT=5434 npm run db:up
PGPORT=5434 npm run test:integration
```

## Credits

This is a port of [strong_migrations](https://github.com/ankane/strong_migrations) by
Andrew Kane. The checks, their conditions, and much of the wording come from that gem.

## License

MIT
