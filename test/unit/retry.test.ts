import { describe, expect, it, vi } from "vitest"
import { isLockTimeout, runWithRetries } from "../../src/runtime/retry"
import { baseConfig, mergeConfig } from "../../src/config"

/**
 * `retry.ts` had no coverage at all, and `lockTimeoutRetries` defaults to `0`, so the
 * integration suite never entered the loop either. It is pure logic with four
 * heuristic branches and an unbounded `for(;;)` — cheap to pin, and the kind of code
 * that fails quietly when it fails.
 */

function checkerStub(overrides: {
    retries?: number
    delay?: string
    inTransaction?: boolean
    skipRetries?: boolean
}) {
    return {
        config: mergeConfig(baseConfig(), {
            lockTimeoutRetries: overrides.retries ?? 0,
            lockTimeoutRetryDelay: (overrides.delay ?? "1ms") as never,
        }),
        rawQueryRunner: {
            isTransactionActive: overrides.inTransaction ?? false,
        },
        state: { skipRetries: overrides.skipRetries ?? false },
    } as never
}

const pgLockTimeout = Object.assign(new Error("canceling statement"), {
    code: "55P03",
})

describe("isLockTimeout", () => {
    it("recognizes the Postgres lock_not_available code", () => {
        expect(isLockTimeout(pgLockTimeout)).toBe(true)
    })

    /**
     * 57014 is `statement_timeout`, not a lock wait. Retrying it just burns another
     * timeout, so the two must not be conflated.
     */
    it("does not treat a statement timeout as a lock timeout", () => {
        expect(
            isLockTimeout(
                Object.assign(new Error("timeout"), { code: "57014" }),
            ),
        ).toBe(false)
    })

    it("recognizes MySQL by errno and by code", () => {
        expect(
            isLockTimeout(Object.assign(new Error("x"), { errno: 1205 })),
        ).toBe(true)
        expect(
            isLockTimeout(
                Object.assign(new Error("x"), { code: "ER_LOCK_WAIT_TIMEOUT" }),
            ),
        ).toBe(true)
    })

    it("falls back to the message when no code is present", () => {
        expect(isLockTimeout(new Error("Lock wait timeout exceeded"))).toBe(
            true,
        )
        expect(isLockTimeout(new Error("something else entirely"))).toBe(false)
    })

    it("is safe on non-errors", () => {
        expect(isLockTimeout(undefined)).toBe(false)
        expect(isLockTimeout(null)).toBe(false)
        expect(isLockTimeout("a string")).toBe(false)
    })
})

describe("runWithRetries", () => {
    it("passes the result straight through when retries are off", async () => {
        const run = vi.fn().mockResolvedValue("ok")
        await expect(
            runWithRetries(checkerStub({ retries: 0 }), run),
        ).resolves.toBe("ok")
        expect(run).toHaveBeenCalledTimes(1)
    })

    it("retries a lock timeout up to the configured count", async () => {
        const run = vi
            .fn()
            .mockRejectedValueOnce(pgLockTimeout)
            .mockRejectedValueOnce(pgLockTimeout)
            .mockResolvedValue("ok")
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            await expect(
                runWithRetries(checkerStub({ retries: 3 }), run),
            ).resolves.toBe("ok")
            expect(run).toHaveBeenCalledTimes(3)
        } finally {
            warn.mockRestore()
        }
    })

    it("gives up after the configured number of attempts", async () => {
        const run = vi.fn().mockRejectedValue(pgLockTimeout)
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
        try {
            await expect(
                runWithRetries(checkerStub({ retries: 2 }), run),
            ).rejects.toBe(pgLockTimeout)
            // The initial attempt plus two retries.
            expect(run).toHaveBeenCalledTimes(3)
        } finally {
            warn.mockRestore()
        }
    })

    it("does not retry an error that is not a lock timeout", async () => {
        const boom = new Error("syntax error")
        const run = vi.fn().mockRejectedValue(boom)
        await expect(
            runWithRetries(checkerStub({ retries: 3 }), run),
        ).rejects.toBe(boom)
        expect(run).toHaveBeenCalledTimes(1)
    })

    /**
     * Postgres has already aborted the transaction, so every later statement fails
     * until rollback. Retrying inside one is pointless — the same restriction the gem
     * has.
     */
    it("does not retry inside a transaction", async () => {
        const run = vi.fn().mockRejectedValue(pgLockTimeout)
        await expect(
            runWithRetries(
                checkerStub({ retries: 3, inTransaction: true }),
                run,
            ),
        ).rejects.toBe(pgLockTimeout)
        expect(run).toHaveBeenCalledTimes(1)
    })

    it("honours the skipRetries flag", async () => {
        const run = vi.fn().mockRejectedValue(pgLockTimeout)
        await expect(
            runWithRetries(checkerStub({ retries: 3, skipRetries: true }), run),
        ).rejects.toBe(pgLockTimeout)
        expect(run).toHaveBeenCalledTimes(1)
    })
})
