import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

const CREDITS_RESPONSE = {
  data: {
    total_credits: 25,
    total_usage: 7.5,
  },
}

const KEY_RESPONSE = {
  data: {
    label: "production key",
    limit: 10,
    usage: 2.5,
    rate_limit: { requests: 200, interval: "10s" },
  },
}

function mockCredentials(ctx, apiKey) {
  ctx.credentials = { apiKey: apiKey || "or-key" }
}

function mockHttp(ctx, opts) {
  const options = opts || {}
  ctx.host.http.request.mockImplementation((req) => {
    if (req.url.endsWith("/key")) {
      if (options.keyStatus) return { status: options.keyStatus, bodyText: options.keyBody || "" }
      if (options.keyBody !== undefined) return { status: 200, bodyText: options.keyBody }
      return { status: 200, bodyText: JSON.stringify(options.keyResponse || KEY_RESPONSE) }
    }
    if (options.creditsStatus) return { status: options.creditsStatus, bodyText: options.creditsBody || "" }
    if (options.creditsBody !== undefined) return { status: 200, bodyText: options.creditsBody }
    return { status: 200, bodyText: JSON.stringify(options.creditsResponse || CREDITS_RESPONSE) }
  })
}

describe("openrouter plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("throws when credentials are missing", async () => {
    const ctx = makeCtx()
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("OpenRouter API key missing")
  })

  it("calls credits and key endpoints with API key auth", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx, "or-test-key")
    mockHttp(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request).toHaveBeenCalledTimes(2)
    const creditsCall = ctx.host.http.request.mock.calls[0][0]
    const keyCall = ctx.host.http.request.mock.calls[1][0]
    expect(creditsCall.method).toBe("GET")
    expect(creditsCall.url).toBe("https://openrouter.ai/api/v1/credits")
    expect(keyCall.url).toBe("https://openrouter.ai/api/v1/key")
    expect(creditsCall.headers.Authorization).toBe("Bearer or-test-key")
    expect(creditsCall.headers["X-Title"]).toBe("OpenUsage")
    expect(keyCall.timeoutMs).toBe(3000)
  })

  it("does not double-prefix Bearer API keys", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx, "Bearer or-test-key")
    mockHttp(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer or-test-key")
  })

  it("uses custom API host", async () => {
    const ctx = makeCtx()
    ctx.credentials = { apiKey: "or-key", apiHost: "openrouter.example.test/api/v1" }
    mockHttp(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request.mock.calls[0][0].url).toBe("https://openrouter.example.test/api/v1/credits")
    expect(ctx.host.http.request.mock.calls[1][0].url).toBe("https://openrouter.example.test/api/v1/key")
  })

  it("renders credits, key quota, rate limit, and plan", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Production Key")
    expect(result.lines).toEqual([
      { type: "progress", label: "Credits", used: 7.5, limit: 25, format: { kind: "dollars" } },
      { type: "progress", label: "Key Quota", used: 2.5, limit: 10, format: { kind: "dollars" } },
      { type: "text", label: "Rate Limit", value: "200 req/10s" },
    ])
  })

  it("ignores key metadata failures", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { keyStatus: 500 })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBeNull()
    expect(result.lines).toHaveLength(1)
    expect(result.lines[0].label).toBe("Credits")
  })

  it("throws on auth status from credits endpoint", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { creditsStatus: 401 })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("OpenRouter API key is invalid")
  })

  it("throws API error detail from credits response", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, {
      creditsStatus: 402,
      creditsBody: JSON.stringify({ error: { message: "Insufficient credits" } }),
    })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("OpenRouter API error: Insufficient credits")
  })

  it("throws on invalid credits JSON", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { creditsBody: "not-json" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("OpenRouter response invalid")
  })

  it("shows no usage badge when no usage lines are available", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, {
      creditsResponse: { data: { total_credits: 0, total_usage: 0 } },
      keyResponse: { data: {} },
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines).toEqual([{ type: "badge", label: "Status", text: "No usage data", color: "#a3a3a3" }])
  })
})
