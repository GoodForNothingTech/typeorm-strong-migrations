/**
 * Matches TypeORM's own Prettier config. Our error messages embed TypeScript
 * source, and that source should look like TypeORM's docs when pasted.
 *
 * @type {import("prettier").Config}
 */
module.exports = {
    semi: false,
    tabWidth: 4,
}
