import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

const creditBlocksPayload = {
  creditBlocks: [
    { amount_mUsd: 10000000, balance_mUsd: 4000000 },
    { amount_mUsd: 5000000, balance_mUsd: 1000000 },
  ],
}

const passPayload = {
  subscription: {
    currentPeriodUsageUsd: 9,
    currentPeriodBaseCreditsUsd: 19,
    currentPeriodBonusCreditsUsd: 6,
    nextBillingAt: "2026-03-01T00:00:00Z",
    tier: "tier_49",
  },
}

function trpcResult(json) {
  return { result: { data: { json } } }
}

function trpcResponse(creditPayload = creditBlocksPayload, kiloPassPayload = passPayload) {
  return [trpcResult(creditPayload), trpcResult(kiloPassPayload)]
}

function mockCredentials(ctx, apiKey) {
  ctx.credentials = { apiKey: apiKey || "kilo-key" }
}

function mockHttp(ctx, opts = {}) {
  ctx.host.http.request.mockReturnValue({
    status: opts.status || 200,
    bodyText: opts.bodyText !== undefined ? opts.bodyText : JSON.stringify(opts.response || trpcResponse()),
  })
}

describe("kilo plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("throws when credentials are missing", async () => {
    const ctx = makeCtx()
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Kilo API key missing")
  })

  it("calls Kilo tRPC batch with API key auth", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx, "kilo-test-key")
    mockHttp(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    const req = ctx.host.http.request.mock.calls[0][0]
    expect(req.method).toBe("GET")
    expect(req.url).toContain("https://app.kilo.ai/api/trpc/user.getCreditBlocks,kiloPass.getState")
    expect(req.url).toContain("batch=1")
    expect(req.url).toContain(encodeURIComponent(JSON.stringify({ "0": null, "1": null })))
    expect(req.url).not.toContain("getAutoTopUpPaymentMethod")
    expect(req.headers.Authorization).toBe("Bearer kilo-test-key")
    expect(req.headers.Accept).toBe("application/json")
  })

  it("uses custom API host and does not double-prefix Bearer tokens", async () => {
    const ctx = makeCtx()
    ctx.credentials = { token: "Bearer kilo-test-key", apiHost: "kilo.example.test/api/trpc" }
    mockHttp(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    const req = ctx.host.http.request.mock.calls[0][0]
    expect(req.url).toContain("https://kilo.example.test/api/trpc/user.getCreditBlocks,kiloPass.getState")
    expect(req.headers.Authorization).toBe("Bearer kilo-test-key")
  })

  it("renders credit blocks, Kilo Pass, bonus details, reset metadata, and plan", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Pro")
    expect(result.lines).toEqual([
      { type: "progress", label: "Credits", used: 66.66666666666666, limit: 100, format: { kind: "percent" } },
      { type: "text", label: "Credit Balance", value: "10/15" },
      {
        type: "progress",
        label: "Kilo Pass",
        used: 9,
        limit: 25,
        format: { kind: "dollars" },
        resetsAt: "2026-03-01T00:00:00.000Z",
      },
      { type: "text", label: "Pass Details", value: "$9.00 / $19.00 (+$6.00 bonus)" },
    ])
  })

  it("renders remaining-only credits as a badge", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { response: trpcResponse({ creditsRemaining: 12 }, null) })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines).toEqual([{ type: "badge", label: "Credits", text: "12 remaining", color: "#22c55e" }])
  })

  it("shows no usage data when payloads contain no usage", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { response: trpcResponse({}, {}) })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines).toEqual([{ type: "badge", label: "Status", text: "No usage data", color: "#a3a3a3" }])
  })

  it("throws on HTTP auth status", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { status: 401, bodyText: "{}" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Kilo authentication failed. Check your API key.")
  })

  it("throws on tRPC auth errors", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, {
      bodyText: JSON.stringify([
        {
          error: {
            message: "User not authenticated - no user to set on context",
            data: { code: "UNAUTHORIZED" },
          },
        },
      ]),
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Kilo authentication failed.")
  })

  it("throws on invalid JSON", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { bodyText: "not-json" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Kilo response invalid")
  })
})
