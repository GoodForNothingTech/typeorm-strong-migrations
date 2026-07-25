/**
 * Check keys are TypeORM-native: they name the method a user actually calls
 * (`createIndex`, not the gem's `add_index`). The gem's snake_case names are
 * accepted everywhere a key is, via GEM_KEY_ALIASES, so a ported Ruby initializer
 * keeps working.
 */
export const CHECK_KEYS = [
    // columns
    "addColumnDefault",
    "addColumnDefaultExpression",
    "addColumnJson",
    "addColumnGeneratedStored",
    "addColumnAutoIncrementing",
    "changeColumn",
    "changeColumnWithNotNull",
    "changeColumnConstraint",
    "changeColumnNullPostgres",
    "changeColumnNullMysql",
    "changeColumnDefault",
    "dropColumn",
    "renameColumn",
    // tables / schemas / types
    "dropTable",
    "renameTable",
    "renameSchema",
    "renameEnumValue",
    // indexes
    "createIndex",
    "dropIndex",
    "createIndexColumns",
    "createIndexCorruption",
    "concurrentIndexInTransaction",
    // constraints
    "createForeignKey",
    "createForeignKeyMysql",
    "validateForeignKey",
    "createCheckConstraint",
    "createCheckConstraintMysql",
    "validateCheckConstraint",
    "createUniqueConstraint",
    "createExclusionConstraint",
    // data
    "backfill",
    "insertSelect",
    "truncate",
    "createPrimaryKey",
    // destructive operations that reached no interception path before
    "clearDatabase",
    "dropSchema",
    "dropDatabase",
    "dropView",
    // heavy operations previously classified benign
    "tableRewrite",
    "vacuumFull",
    "disableTrigger",
    "flushTables",
    // MySQL DDL options
    "copyAlgorithm",
    "lockOption",
    // TypeORM-specific
    "transactionMode",
    "rawQuery",
    "partialParse",
] as const

export type CheckKey = (typeof CHECK_KEYS)[number]

const CHECK_KEY_SET: ReadonlySet<string> = new Set<string>(CHECK_KEYS)

export function isCheckKey(value: string): value is CheckKey {
    return CHECK_KEY_SET.has(value)
}

/**
 * Disabled unless explicitly enabled.
 *
 * - `dropIndex` mirrors the gem, which ships `remove_index` off.
 * - `changeColumnDefault` guards Rails `partial_inserts`, which has no TypeORM
 *   analogue. The key exists only so a config ported from Ruby does not throw.
 */
export const DEFAULT_DISABLED_KEYS: readonly CheckKey[] = [
    "dropIndex",
    "changeColumnDefault",
]

/**
 * strong_migrations key -> our key(s). Some Rails names are macros that expand to
 * several TypeORM operations, so an alias may resolve to more than one key.
 */
export const GEM_KEY_ALIASES: Readonly<
    Record<string, CheckKey | readonly CheckKey[]>
> = {
    add_column_default: "addColumnDefault",
    add_column_default_callable: "addColumnDefaultExpression",
    add_column_json: "addColumnJson",
    add_column_generated_stored: "addColumnGeneratedStored",
    add_column_auto_incrementing: "addColumnAutoIncrementing",
    change_column: "changeColumn",
    change_column_with_not_null: "changeColumnWithNotNull",
    change_column_constraint: "changeColumnConstraint",
    change_column_null_postgresql: "changeColumnNullPostgres",
    change_column_null_mysql: "changeColumnNullMysql",
    change_column_default: "changeColumnDefault",
    change_column_null: "backfill",
    add_primary_key: "createPrimaryKey",
    remove_column: "dropColumn",
    rename_column: "renameColumn",
    rename_table: "renameTable",
    rename_schema: "renameSchema",
    rename_enum_value: "renameEnumValue",
    add_index: "createIndex",
    remove_index: "dropIndex",
    add_index_columns: "createIndexColumns",
    add_index_corruption: "createIndexCorruption",
    add_foreign_key: "createForeignKey",
    add_foreign_key_mysql: "createForeignKeyMysql",
    validate_foreign_key: "validateForeignKey",
    add_check_constraint: "createCheckConstraint",
    add_check_constraint_mysql: "createCheckConstraintMysql",
    validate_check_constraint: "validateCheckConstraint",
    add_unique_constraint: "createUniqueConstraint",
    add_exclusion_constraint: "createExclusionConstraint",
    copy_algorithm: "copyAlgorithm",
    lock_option: "lockOption",
    execute: "rawQuery",
    change_table: "rawQuery",
    // `create_table force:` compiles to DROP TABLE + CREATE TABLE; the hazard is the drop.
    create_table: "dropTable",
    create_join_table: "dropTable",
    // Rails macros: a column, an index and a foreign key at once.
    add_reference: ["createIndex", "createForeignKey"],
    add_belongs_to: ["createIndex", "createForeignKey"],
}

export type CheckKeyInput =
    CheckKey | keyof typeof GEM_KEY_ALIASES | (string & {})

/** Normalizes a key or gem alias to the set of keys it addresses. */
export function resolveCheckKeys(input: CheckKeyInput): CheckKey[] {
    if (isCheckKey(input)) return [input]
    // `hasOwnProperty`, not a bare lookup: keys like "constructor" or "toString"
    // would otherwise resolve to inherited Object.prototype members, sail past the
    // `!alias` guard as truthy non-strings, and be accepted as valid check keys.
    if (!Object.prototype.hasOwnProperty.call(GEM_KEY_ALIASES, input)) return []
    const alias = GEM_KEY_ALIASES[input]
    if (!alias) return []
    return Array.isArray(alias) ? [...alias] : [alias as CheckKey]
}
