import { beforeEach } from "vitest"
import { resetState } from "../../src/state"

// Config is a module singleton, so each test starts from documented defaults.
beforeEach(() => {
    resetState()
    delete process.env.SAFETY_ASSURED
})
