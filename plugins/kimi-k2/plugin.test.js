import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

function mockCredentials(ctx, apiKey = "kimi-k2-key") {
  ctx.credentials = { apiKey }
}

function mockHttp(ctx, opts = {}) {
  ctx.host.http.request.mockReturnValue({
    status: opts.status || 200,
    headers: opts.headers || {},
    bodyText: opts.bodyText !== undefined ? opts.bodyText : JSON.stringify(opts.response || {
      data: {
        usage: {
          total: 120,
          credits_remaining: 30,
          average_tokens: 42,
        },
      },
    }),
  })
}

describe("kimi-k2 plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("throws when credentials are missing", async () => {
    const ctx = makeCtx()
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Kimi K2 API key missing")
  })

  it("calls credits endpoint with API key auth", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx, "k2-test-key")
    mockHttp(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    const req = ctx.host.http.request.mock.calls[0][0]
    expect(req.method).toBe("GET")
    expect(req.url).toBe("https://kimi-k2.ai/api/user/credits")
    expect(req.headers.Authorization).toBe("Bearer k2-test-key")
    expect(req.headers.Accept).toBe("application/json")
  })

  it("does not double-prefix Bearer API keys", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx, "Bearer k2-test-key")
    mockHttp(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer k2-test-key")
  })

  it("renders credits from nested usage data", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBeNull()
    expect(result.lines).toEqual([
      { type: "progress", label: "Credits", used: 120, limit: 150, format: { kind: "count", suffix: "credits" } },
      { type: "text", label: "Remaining", value: "30 credits" },
      { type: "text", label: "Avg Tokens", value: "42" },
    ])
  })

  it("uses remaining credits header fallback", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, {
      headers: { "X-Credits-Remaining": "25" },
      response: { total_credits_consumed: 50 },
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines[0]).toEqual({
      type: "progress",
      label: "Credits",
      used: 50,
      limit: 75,
      format: { kind: "count", suffix: "credits" },
    })
    expect(result.lines[1]).toEqual({ type: "text", label: "Remaining", value: "25 credits" })
  })

  it("renders no credits when total is zero", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { response: { total_credits_consumed: 0, credits_remaining: 0 } })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines).toEqual([{ type: "badge", label: "Status", text: "No credits", color: "#f59e0b" }])
  })

  it("throws when usage fields are missing", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { response: { data: {} } })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Kimi K2 credits response missing usage data")
  })

  it("throws on auth status", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { status: 403, bodyText: "" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Kimi K2 API key is invalid")
  })

  it("throws API detail from error response", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { status: 500, bodyText: JSON.stringify({ error: { message: "Temporary outage" } }) })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Kimi K2 API error: Temporary outage")
  })

  it("throws on invalid JSON", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { bodyText: "not-json" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Kimi K2 response invalid")
  })
})
