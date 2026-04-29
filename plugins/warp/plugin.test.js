import { beforeEach, describe, expect, it, vi } from "vitest"
import { makeCtx } from "../test-helpers.js"

const PERIOD_24_HOURS_MS = 24 * 60 * 60 * 1000

const loadPlugin = async () => {
  await import("./plugin.js")
  return globalThis.__openusage_plugin
}

const makeWarpResponse = (overrides = {}) => ({
  data: {
    user: {
      __typename: "UserOutput",
      user: {
        requestLimitInfo: {
          isUnlimited: false,
          nextRefreshTime: "2026-02-03T00:00:00Z",
          requestLimit: 100,
          requestsUsedSinceLastRefresh: 30,
        },
        bonusGrants: [
          {
            requestCreditsGranted: 100,
            requestCreditsRemaining: 40,
            expiration: "2026-03-01T00:00:00Z",
          },
        ],
        workspaces: [
          {
            bonusGrantsInfo: {
              grants: [
                {
                  requestCreditsGranted: 50,
                  requestCreditsRemaining: 10,
                  expiration: "2026-03-01T00:00:00Z",
                },
              ],
            },
          },
        ],
        ...overrides,
      },
    },
  },
})

function mockCredentials(ctx, apiKey) {
  ctx.credentials = { apiKey: apiKey || "warp-key" }
}

function mockHttp(ctx, opts = {}) {
  ctx.host.http.request.mockReturnValue({
    status: opts.status || 200,
    bodyText: opts.bodyText !== undefined ? opts.bodyText : JSON.stringify(opts.response || makeWarpResponse()),
  })
}

describe("warp plugin", () => {
  beforeEach(() => {
    delete globalThis.__openusage_plugin
    vi.resetModules()
  })

  it("throws when credentials are missing", async () => {
    const ctx = makeCtx()
    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Warp API key missing")
  })

  it("calls Warp GraphQL with API key auth and camelCase variables", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx, "warp-test-key")
    mockHttp(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request).toHaveBeenCalledTimes(1)
    const req = ctx.host.http.request.mock.calls[0][0]
    expect(req.method).toBe("POST")
    expect(req.url).toBe("https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo")
    expect(req.headers.Authorization).toBe("Bearer warp-test-key")
    expect(req.headers["Content-Type"]).toBe("application/json")
    expect(req.headers["x-warp-client-id"]).toBe("warp-app")
    expect(req.timeoutMs).toBe(10000)

    const body = JSON.parse(req.bodyText)
    expect(body.operationName).toBe("GetRequestLimitInfo")
    expect(body.query).toContain("requestLimitInfo")
    expect(body.variables.requestContext.clientContext).toEqual({})
    expect(body.variables.requestContext.osContext.name).toBe("macOS")
    expect(body.variables.request_context).toBeUndefined()
  })

  it("does not double-prefix Bearer tokens and accepts aliases", async () => {
    const ctx = makeCtx()
    ctx.credentials = { token: "Bearer warp-test-key" }
    mockHttp(ctx)

    const plugin = await loadPlugin()
    plugin.probe(ctx)

    expect(ctx.host.http.request.mock.calls[0][0].headers.Authorization).toBe("Bearer warp-test-key")
  })

  it("renders daily credits, add-on credits, and reset metadata", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx)

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBeNull()
    expect(result.lines[0]).toEqual({
      type: "progress",
      label: "Credits",
      used: 30,
      limit: 100,
      format: { kind: "percent" },
      resetsAt: "2026-02-03T00:00:00.000Z",
      periodDurationMs: PERIOD_24_HOURS_MS,
    })
    expect(result.lines[1]).toMatchObject({
      type: "progress",
      label: "Add-on Credits",
      limit: 100,
      format: { kind: "percent" },
    })
    expect(result.lines[1].used).toBeCloseTo(66.666, 2)
  })

  it("renders unlimited accounts as plan and status badge", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, {
      response: makeWarpResponse({
        requestLimitInfo: {
          isUnlimited: true,
          nextRefreshTime: null,
          requestLimit: 0,
          requestsUsedSinceLastRefresh: 0,
        },
        bonusGrants: [],
        workspaces: [],
      }),
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.plan).toBe("Unlimited")
    expect(result.lines).toEqual([{ type: "badge", label: "Status", text: "Unlimited", color: "#22c55e" }])
  })

  it("shows no usage data when no limits or bonus credits are available", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, {
      response: makeWarpResponse({
        requestLimitInfo: {
          isUnlimited: false,
          nextRefreshTime: null,
          requestLimit: 0,
          requestsUsedSinceLastRefresh: 0,
        },
        bonusGrants: [],
        workspaces: [],
      }),
    })

    const plugin = await loadPlugin()
    const result = plugin.probe(ctx)

    expect(result.lines).toEqual([{ type: "badge", label: "Status", text: "No usage data", color: "#a3a3a3" }])
  })

  it("throws on auth status", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { status: 401, bodyText: "{}" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Warp API key is invalid")
  })

  it("throws GraphQL errors from successful responses", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { bodyText: JSON.stringify({ errors: [{ message: "Unauthorized: User not in context" }] }) })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Warp API error: Unauthorized: User not in context")
  })

  it("throws on invalid JSON", async () => {
    const ctx = makeCtx()
    mockCredentials(ctx)
    mockHttp(ctx, { bodyText: "not-json" })

    const plugin = await loadPlugin()
    expect(() => plugin.probe(ctx)).toThrow("Warp response invalid")
  })
})
