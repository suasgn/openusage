import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

const COOKIE_HEADER = "ory_session_mistral=secret-session; csrftoken=csrf-token"

const USAGE_RESPONSE = {
  completion: {
    models: {
      "mistral-large-latest::mistral-large-2411": {
        input: [
          {
            billing_metric: "mistral-large-2411",
            billing_group: "input",
            value: 11121,
            value_paid: 11121,
          },
        ],
        output: [
          {
            billing_metric: "mistral-large-2411",
            billing_group: "output",
            value: 1115,
            value_paid: 1115,
          },
        ],
      },
      "mistral-small-latest::mistral-small-2506": {
        input: [
          { billing_metric: "mistral-small-2506", billing_group: "input", value_paid: 120 },
        ],
        output: [
          { billing_metric: "mistral-small-2506", billing_group: "output", value_paid: 2982 },
        ],
      },
    },
  },
  ocr: { models: {} },
  connectors: { models: {} },
  libraries_api: { pages: { models: {} }, tokens: { models: {} } },
  fine_tuning: { training: {}, storage: {} },
  audio: { models: {} },
  start_date: "2026-02-01T00:00:00Z",
  end_date: "2026-02-28T23:59:59.999Z",
  currency: "EUR",
  currency_symbol: "EUR ",
  prices: [
    { billing_metric: "mistral-large-2411", billing_group: "input", price: "0.0000017000" },
    { billing_metric: "mistral-large-2411", billing_group: "output", price: "0.0000051000" },
    { billing_metric: "mistral-small-2506", billing_group: "input", price: "0.0000000850" },
    { billing_metric: "mistral-small-2506", billing_group: "output", price: "0.0000002550" },
  ],
}

function mockCredentials(ctx, cookieHeader = COOKIE_HEADER) {
  ctx.credentials = { cookieHeader }
}

function mockHttp(ctx, opts = {}) {
  ctx.host.http.request.mockReturnValue({
    status: opts.status || 200,
    bodyText: opts.bodyText !== undefined ? opts.bodyText : JSON.stringify(opts.response || USAGE_RESPONSE),
  })
}

describe("mistral plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("throws when credentials are missing", async () => {
    const ctx = makeCtx()
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Mistral session cookie missing")
  })

  it("requires an ory session cookie", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx, "csrftoken=csrf-token")
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("missing ory_session_*")
  })

  it("calls current month billing endpoint with cookie and csrf", async () => {
    const ctx = makeCtx()
    ctx.nowIso = "2026-02-15T12:00:00.000Z"
    mockCredentials(ctx)
    mockHttp(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    const req = ctx.host.http.request.mock.calls[0][0]
    expect(req.method).toBe("GET")
    expect(req.url).toBe("https://admin.mistral.ai/api/billing/v2/usage?month=2&year=2026")
    expect(req.headers.Cookie).toBe(COOKIE_HEADER)
    expect(req.headers["X-CSRFTOKEN"]).toBe("csrf-token")
    expect(req.headers.Referer).toBe("https://admin.mistral.ai/organization/usage")
  })

  it("renders monthly cost and token totals", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBeNull()
    expect(result.lines[0]).toEqual({
      type: "text",
      label: "Cost",
      value: "EUR 0.0254",
      subtitle: "This month, resets 2026-02-28",
    })
    expect(result.lines[1]).toEqual({ type: "text", label: "Input Tokens", value: "11,241" })
    expect(result.lines[2]).toEqual({ type: "text", label: "Output Tokens", value: "4,097" })
    expect(result.lines.find((line) => line.label === "Models")).toEqual({ type: "text", label: "Models", value: "2" })
  })

  it("renders no usage status for empty usage", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, {
      response: {
        completion: { models: {} },
        prices: [],
        currency: "EUR",
        currency_symbol: "EUR ",
      },
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)
    expect(result.lines).toEqual([
      { type: "text", label: "Cost", value: "EUR 0.0000", subtitle: "This month" },
      { type: "text", label: "Input Tokens", value: "0" },
      { type: "text", label: "Output Tokens", value: "0" },
      { type: "badge", label: "Status", text: "No usage", color: "#a3a3a3" },
    ])
  })

  it("throws on auth status", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { status: 401, bodyText: "" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Mistral session cookie is invalid")
  })

  it("throws API detail from error response", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { status: 500, bodyText: JSON.stringify({ message: "Billing unavailable" }) })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Mistral API error: Billing unavailable")
  })

  it("throws on invalid JSON", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { bodyText: "not-json" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Mistral response invalid")
  })
})
