import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

const BALANCE_RESPONSE = {
  is_available: true,
  balance_infos: [
    {
      currency: "USD",
      total_balance: "50.00",
      granted_balance: "10.00",
      topped_up_balance: "40.00",
    },
  ],
}

function mockCredentials(ctx, apiKey = "deepseek-key") {
  ctx.credentials = { apiKey }
}

function mockHttp(ctx, opts = {}) {
  ctx.host.http.request.mockReturnValue({
    status: opts.status || 200,
    bodyText: opts.bodyText !== undefined ? opts.bodyText : JSON.stringify(opts.response || BALANCE_RESPONSE),
  })
}

describe("deepseek plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("throws when credentials are missing", async () => {
    const ctx = makeCtx()
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("DeepSeek API key missing")
  })

  it("calls balance endpoint with API key auth", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx, "ds-test-key")
    mockHttp(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    const req = ctx.host.http.request.mock.calls[0][0]
    expect(req.method).toBe("GET")
    expect(req.url).toBe("https://api.deepseek.com/user/balance")
    expect(req.headers.Authorization).toBe("Bearer ds-test-key")
    expect(req.headers.Accept).toBe("application/json")
  })

  it("does not double-prefix Bearer API keys", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx, "Bearer ds-test-key")
    mockHttp(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer ds-test-key")
  })

  it("renders USD balance with paid and granted breakdown", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBeNull()
    expect(result.lines).toEqual([
      { type: "text", label: "Balance", value: "$50.00", subtitle: "Paid $40.00 / Granted $10.00" },
      { type: "text", label: "Paid", value: "$40.00" },
      { type: "text", label: "Granted", value: "$10.00" },
    ])
  })

  it("prefers USD when multiple currencies are present", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, {
      response: {
        is_available: true,
        balance_infos: [
          { currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" },
          { currency: "USD", total_balance: "20.00", granted_balance: "5.00", topped_up_balance: "15.00" },
        ],
      },
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines[0].value).toBe("$20.00")
  })

  it("shows unavailable status when API marks account unavailable", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { response: { ...BALANCE_RESPONSE, is_available: false } })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines.find((line) => line.label === "Status")).toEqual({
      type: "badge",
      label: "Status",
      text: "Unavailable",
      color: "#ef4444",
    })
  })

  it("returns no balance data badge when balance infos are empty", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { response: { is_available: true, balance_infos: [] } })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines).toEqual([{ type: "badge", label: "Status", text: "No balance data", color: "#a3a3a3" }])
  })

  it("throws on malformed balance values", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, {
      response: {
        is_available: true,
        balance_infos: [{ currency: "USD", total_balance: "nope", granted_balance: "0", topped_up_balance: "0" }],
      },
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("DeepSeek balance response invalid")
  })

  it("throws on auth status", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { status: 401, bodyText: "" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("DeepSeek API key is invalid")
  })

  it("throws API detail from error response", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { status: 429, bodyText: JSON.stringify({ message: "Rate limit exceeded" }) })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("DeepSeek API error: Rate limit exceeded")
  })

  it("throws on invalid JSON", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { bodyText: "not-json" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("DeepSeek response invalid")
  })
})
