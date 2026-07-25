import "reflect-metadata"
import { beforeEach } from "vitest"
import { resetState } from "../../src/state"

beforeEach(() => {
    resetState()
    delete process.env.SAFETY_ASSURED
})
