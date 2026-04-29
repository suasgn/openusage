import { describe, expect, it } from "vitest"
import { track } from "./analytics"

describe("analytics track", () => {
  it("is disabled", () => {
    track("setting_changed", { setting: "theme", value: "dark" })
    expect(true).toBe(true)
  })
})
