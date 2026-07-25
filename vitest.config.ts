import { defineConfig } from "vitest/config"

export default defineConfig({
    test: {
        projects: [
            {
                test: {
                    name: "unit",
                    include: [
                        "test/unit/**/*.test.ts",
                        "test/checks/**/*.test.ts",
                    ],
                    environment: "node",
                    setupFiles: ["test/helpers/setup-unit.ts"],
                },
            },
            {
                test: {
                    name: "integration",
                    include: ["test/integration/**/*.test.ts"],
                    environment: "node",
                    // Every file boots a DataSource against a shared database and mutates
                    // schema, so files must not overlap.
                    pool: "forks",
                    fileParallelism: false,
                    sequence: { concurrent: false },
                    testTimeout: 60_000,
                    hookTimeout: 60_000,
                    setupFiles: ["test/helpers/setup-integration.ts"],
                },
            },
        ],
        coverage: {
            provider: "v8",
            include: ["src/**"],
            exclude: ["**/*.d.ts", "src/register.ts"],
            reporter: ["text", "lcov"],
            // A ratchet floor set just under current, not an aspiration. Its job is
            // to stop a module quietly falling to zero the way retry.ts and
            // logger-layer.ts had — a threshold that fails on the day it lands
            // teaches people to ignore it. Raise it as coverage rises.
            thresholds: {
                lines: 78,
                functions: 75,
                branches: 64,
                statements: 74,
            },
        },
    },
})
