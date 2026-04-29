import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

function writeCredentials(ctx, overrides = {}) {
  ctx.credentials = { type: "cookie", cookieHeader: "auth=session", ...overrides }
}

function subscriptionPayload(overrides = {}) {
  return JSON.stringify({
    data: {
      usage: {
        rollingUsage: { usagePercent: 12.5, resetInSec: 600 },
        weeklyUsage: { usagePercent: 47, resetInSec: 7200 },
        planType: "team",
        ...overrides,
      },
    },
  })
}

function goPayload() {
  return `
    <html><body><script>
      const payload = {
        rollingUsage: { usagePercent: 10, resetInSec: 300 },
        weeklyUsage: { usagePercent: 25, resetInSec: 600 },
        monthlyUsage: { usagePercent: 50, resetInSec: 900 }
      };
    </script></body></html>
  `
}

function mockOpenCodeHttp(ctx, options = {}) {
  ctx.host.http.request.mockImplementation((req) => {
    const url = String(req.url)
    if (url.includes("/_server") && req.headers["X-Server-Id"]?.startsWith("def399")) {
      return { status: 200, bodyText: JSON.stringify({ data: [{ id: "wrk_test123" }] }) }
    }
    if (url.includes("/_server") && req.headers["X-Server-Id"]?.startsWith("7abe")) {
      if (options.subscriptionStatus) return { status: options.subscriptionStatus, bodyText: options.subscriptionBody || "" }
      return { status: 200, bodyText: options.subscriptionBody || subscriptionPayload(options.subscriptionOverrides) }
    }
    if (url.includes("/workspace/") && url.includes("/go")) {
      if (options.goStatus) return { status: options.goStatus, bodyText: options.goBody || "" }
      return { status: 200, bodyText: options.goBody || goPayload() }
    }
    return { status: 404, bodyText: "" }
  })
}

describe("opencode plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-02-02T00:00:00.000Z"))
  })

  it("throws when cookie credentials are missing", async () => {
    const ctx = makeCtx()
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("OpenCode session cookie is invalid")
  })

  it("discovers workspace and fetches subscription plus Go usage", async () => {
    const ctx = makeCtx()
    writeCredentials(ctx)
    mockOpenCodeHttp(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Team")
    expect(result.lines).toEqual([
      { type: "progress", label: "Session", used: 12.5, limit: 100, format: { kind: "percent" }, resetsAt: "2026-02-02T00:10:00.000Z", periodDurationMs: 5 * 60 * 60 * 1000 },
      { type: "progress", label: "Weekly", used: 47, limit: 100, format: { kind: "percent" }, resetsAt: "2026-02-02T02:00:00.000Z", periodDurationMs: 7 * 24 * 60 * 60 * 1000 },
      { type: "progress", label: "Go Session", used: 10, limit: 100, format: { kind: "percent" }, resetsAt: "2026-02-02T00:05:00.000Z", periodDurationMs: 5 * 60 * 60 * 1000 },
      { type: "progress", label: "Go Weekly", used: 25, limit: 100, format: { kind: "percent" }, resetsAt: "2026-02-02T00:10:00.000Z", periodDurationMs: 7 * 24 * 60 * 60 * 1000 },
      { type: "progress", label: "Go Monthly", used: 50, limit: 100, format: { kind: "percent" }, resetsAt: "2026-02-02T00:15:00.000Z", periodDurationMs: 30 * 24 * 60 * 60 * 1000 },
    ])

    expect(ctx.host.http.request.mock.calls[0][0].url).toContain("/_server?id=def399")
    expect(ctx.host.http.request.mock.calls[0][0].headers.Cookie).toBe("auth=session")
    expect(ctx.host.http.request.mock.calls[1][0].url).toContain("args=%5B%22wrk_test123%22%5D")
    expect(ctx.host.http.request.mock.calls[2][0].url).toBe("https://opencode.ai/workspace/wrk_test123/go")
  })

  it("uses workspace ID from credentials without discovery", async () => {
    const ctx = makeCtx()
    writeCredentials(ctx, { workspaceId: "wrk_known" })
    mockOpenCodeHttp(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request.mock.calls[0][0].headers["X-Server-Id"]).toContain("7abe")
    expect(ctx.host.http.request.mock.calls[0][0].url).toContain("wrk_known")
  })

  it("renders monthly cost and subscription row badge when present", async () => {
    const ctx = makeCtx()
    writeCredentials(ctx, { workspaceId: "wrk_known" })
    mockOpenCodeHttp(ctx, {
      subscriptionBody: `{"usage":[{"date":"2026-02-01","totalCost":1.25,"subscription":true},{"date":"2026-02-02","totalCost":2.5,"subscription":true}],"extra":{"subscription":true},"rollingUsage":{"usagePercent":1,"resetInSec":60},"weeklyUsage":{"usagePercent":2,"resetInSec":120},"planType":"pro"}`,
      goStatus: 500,
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Pro")
    expect(result.lines).toContainEqual({ type: "text", label: "Monthly Cost", value: "$3.75" })
    expect(result.lines).toContainEqual({ type: "badge", label: "Subscription Rows", text: "3" })
  })

  it("falls back to Go usage when subscription is unavailable", async () => {
    const ctx = makeCtx()
    writeCredentials(ctx, { workspaceId: "wrk_known" })
    mockOpenCodeHttp(ctx, { subscriptionStatus: 500, subscriptionBody: "server error" })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines.find((line) => line.label === "Go Session")).toBeTruthy()
    expect(result.lines.find((line) => line.label === "Session")).toBeFalsy()
  })

  it("throws auth error on unauthorized responses", async () => {
    const ctx = makeCtx()
    writeCredentials(ctx, { workspaceId: "wrk_known" })
    mockOpenCodeHttp(ctx, { subscriptionStatus: 401, goStatus: 401 })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("OpenCode session cookie is invalid")
  })
})
