import js from "@eslint/js"
import { defineConfig, globalIgnores } from "eslint/config"
import ts from "typescript-eslint"

const __dirname = import.meta.dirname

export default defineConfig([
    globalIgnores([
        "dist/**",
        "node_modules/**",
        "coverage/**",
        // Reference checkouts, not our source.
        "typeorm/**",
        "strong_migrations/**",
        "nestjs-typeorm/**",
    ]),

    {
        files: ["**/*.ts", "**/*.mts"],
        languageOptions: {
            parser: ts.parser,
            parserOptions: {
                tsconfigRootDir: __dirname,
                project: "tsconfig.json",
            },
        },
        plugins: { js, ts },
        extends: [js.configs.recommended, ...ts.configs.recommended],
        rules: {
            // Runtime values from `typeorm` must be resolved lazily so a single build
            // works across TypeORM 0.3 and 1.x, where some symbols exist in only one.
            // Types are fine — they erase completely.
            "no-restricted-imports": [
                "error",
                {
                    paths: [
                        {
                            name: "typeorm",
                            allowTypeImports: true,
                            message:
                                "Use src/compat/typeorm.ts (lazy require) for runtime values.",
                        },
                    ],
                },
            ],
            "@typescript-eslint/consistent-type-imports": "error",
            // A leading underscore marks a parameter kept for interface conformance.
            "@typescript-eslint/no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
            ],
            "@typescript-eslint/no-explicit-any": "off",
        },
    },

    {
        // register.ts patches DataSource.prototype, so it needs the class itself.
        files: ["src/compat/typeorm.ts", "src/register.ts"],
        rules: {
            "no-restricted-imports": "off",
            "@typescript-eslint/no-require-imports": "off",
        },
    },

    {
        files: ["test/**/*.ts", "scripts/**/*.mjs", "scripts/**/*.ts"],
        rules: {
            "no-restricted-imports": "off",
            "@typescript-eslint/no-explicit-any": "off",
            "@typescript-eslint/no-require-imports": "off",
        },
    },
])
