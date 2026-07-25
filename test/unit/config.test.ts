import { describe, expect, it } from "vitest"
import { CHECK_KEYS } from "../../src/checks/keys"
import {
    baseConfig,
    currentEnv,
    isDeveloperEnv,
    mergeConfig,
    resolvedTargetVersion,
} from "../../src/config"
import { StrongMigrationsConfigError } from "../../src/errors"
import { parseDuration, postgresTimeoutToMs } from "../../src/util/duration"

describe("config", () => {
    /**
     * A documented divergence from the gem, which *replaces* enabled_checks — so
     * setting one key there silently turns off the other thirty.
     */
    it("merges enabledChecks over the defaults rather than replacing them", () => {
        const config = mergeConfig(baseConfig(), {
            enabledChecks: { createIndex: false },
        })
        expect(config.enabledChecks.has("createIndex")).toBe(false)
        expect(config.enabledChecks.has("dropColumn")).toBe(true)
        expect(config.enabledChecks.size).toBe(CHECK_KEYS.length - 3)
    })

    it("accepts gem aliases as enabledChecks keys", () => {
        const config = mergeConfig(baseConfig(), {
            enabledChecks: { remove_column: false },
        })
        expect(config.enabledChecks.has("dropColumn")).toBe(false)
    })

    it("expands a gem macro alias to every key it covers", () => {
        const config = mergeConfig(baseConfig(), {
            enabledChecks: { add_reference: false },
        })
        expect(config.enabledChecks.has("createIndex")).toBe(false)
        expect(config.enabledChecks.has("createForeignKey")).toBe(false)
    })

    it("rejects an unknown key rather than silently ignoring it", () => {
        expect(() =>
            mergeConfig(baseConfig(), { enabledChecks: { nope: false } }),
        ).toThrow(StrongMigrationsConfigError)
        expect(() =>
            mergeConfig(baseConfig(), {
                errorMessages: { nope: "x" } as never,
            }),
        ).toThrow(StrongMigrationsConfigError)
    })

    it("ships dropIndex and changeColumnDefault off, matching the documented opt-ins", () => {
        const config = baseConfig()
        expect(config.enabledChecks.has("dropIndex")).toBe(false)
        expect(config.enabledChecks.has("changeColumnDefault")).toBe(false)
    })

    it("appends custom checks instead of replacing them", () => {
        const first = () => {}
        const second = () => {}
        const config = mergeConfig(
            mergeConfig(baseConfig(), { checks: [first] }),
            {
                checks: [second],
            },
        )
        expect(config.checks).toEqual([first, second])
    })

    it("merges errorMessages over the built-ins", () => {
        const config = mergeConfig(baseConfig(), {
            errorMessages: { createIndex: "custom" },
        })
        expect(config.errorMessages.createIndex).toBe("custom")
    })
})

describe("environment detection", () => {
    /**
     * Unset NODE_ENV means production. That inverts the usual Node convention on
     * purpose: if we cannot prove we are in development, checks must not be relaxed.
     */
    it("defaults to production when nothing is set", () => {
        const saved = {
            node: process.env.NODE_ENV,
            sm: process.env.STRONG_MIGRATIONS_ENV,
        }
        delete process.env.NODE_ENV
        delete process.env.STRONG_MIGRATIONS_ENV
        try {
            expect(currentEnv()).toBe("production")
            expect(isDeveloperEnv(currentEnv())).toBe(false)
        } finally {
            if (saved.node) process.env.NODE_ENV = saved.node
            if (saved.sm) process.env.STRONG_MIGRATIONS_ENV = saved.sm
        }
    })

    it("prefers STRONG_MIGRATIONS_ENV over NODE_ENV", () => {
        const saved = {
            node: process.env.NODE_ENV,
            sm: process.env.STRONG_MIGRATIONS_ENV,
        }
        process.env.NODE_ENV = "production"
        process.env.STRONG_MIGRATIONS_ENV = "development"
        try {
            expect(currentEnv()).toBe("development")
        } finally {
            process.env.NODE_ENV = saved.node
            if (saved.sm) process.env.STRONG_MIGRATIONS_ENV = saved.sm
            else delete process.env.STRONG_MIGRATIONS_ENV
        }
    })

    it("honours targetVersion only in development or test", () => {
        const dev = mergeConfig(baseConfig(), {
            env: "development",
            targetVersion: 18,
        })
        expect(resolvedTargetVersion(dev, "postgres")).toBe("18")

        const prod = mergeConfig(baseConfig(), {
            env: "production",
            targetVersion: 18,
        })
        expect(resolvedTargetVersion(prod, "postgres")).toBeUndefined()
    })

    it("supports a per-engine targetVersion map", () => {
        const config = mergeConfig(baseConfig(), {
            env: "test",
            targetVersion: { postgres: 16, mysql: "8.4" },
        })
        expect(resolvedTargetVersion(config, "postgres")).toBe("16")
        expect(resolvedTargetVersion(config, "mysql")).toBe("8.4")
        expect(resolvedTargetVersion(config, "mariadb")).toBeUndefined()
    })

    it("turns the lock timeout warning off in development and on elsewhere", () => {
        expect(
            mergeConfig(baseConfig(), { env: "development" }).lockTimeoutLimit,
        ).toBe(false)
        expect(
            mergeConfig(baseConfig(), { env: "production" }).lockTimeoutLimit,
        ).toBe("10s")
    })

    it("lets an explicit lockTimeoutLimit win over the env-derived default", () => {
        expect(
            mergeConfig(baseConfig(), {
                env: "development",
                lockTimeoutLimit: "5s",
            }).lockTimeoutLimit,
        ).toBe("5s")
    })
})

describe("durations", () => {
    it("reads the documented string forms", () => {
        expect(parseDuration("10s", "x")).toBe(10_000)
        expect(parseDuration("500ms", "x")).toBe(500)
        expect(parseDuration("5m", "x")).toBe(300_000)
        expect(parseDuration("1h", "x")).toBe(3_600_000)
    })

    it("treats a bare number as milliseconds", () => {
        expect(parseDuration(10_000, "x")).toBe(10_000)
    })

    it("rejects nonsense with the option name in the message", () => {
        expect(() => parseDuration("soon" as never, "lockTimeout")).toThrow(
            /lockTimeout/,
        )
        expect(() => parseDuration(-1, "lockTimeout")).toThrow(/lockTimeout/)
    })

    it("converts every unit Postgres reports from SHOW lock_timeout", () => {
        expect(postgresTimeoutToMs("0")).toBe(0)
        expect(postgresTimeoutToMs("250ms")).toBe(250)
        expect(postgresTimeoutToMs("10s")).toBe(10_000)
        expect(postgresTimeoutToMs("2min")).toBe(120_000)
        expect(postgresTimeoutToMs("1h")).toBe(3_600_000)
        expect(postgresTimeoutToMs("1d")).toBe(86_400_000)
        expect(postgresTimeoutToMs("1us")).toBeCloseTo(0.001)
    })
})
