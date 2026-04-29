(function () {
  const API_URL = "https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo"
  const PERIOD_24_HOURS_MS = 24 * 60 * 60 * 1000
  const GRAPHQL_QUERY = `
query GetRequestLimitInfo($requestContext: RequestContext!) {
  user(requestContext: $requestContext) {
    __typename
    ... on UserOutput {
      user {
        requestLimitInfo {
          isUnlimited
          nextRefreshTime
          requestLimit
          requestsUsedSinceLastRefresh
        }
        bonusGrants {
          requestCreditsGranted
          requestCreditsRemaining
          expiration
        }
        workspaces {
          bonusGrantsInfo {
            grants {
              requestCreditsGranted
              requestCreditsRemaining
              expiration
            }
          }
        }
      }
    }
  }
}`

  function readString(value) {
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }

  function readNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }

  function pickString(values) {
    for (let i = 0; i < values.length; i += 1) {
      const value = readString(values[i])
      if (value) return value
    }
    return null
  }

  function authHeader(apiKey) {
    const key = readString(apiKey)
    if (!key) return ""
    if (key.toLowerCase().startsWith("bearer ")) return key
    return "Bearer " + key
  }

  function clampPercent(value) {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.min(100, value))
  }

  function loadCredentials(ctx) {
    const credentials = ctx.credentials && typeof ctx.credentials === "object" ? ctx.credentials : null
    return {
      apiKey: pickString([
        credentials && credentials.apiKey,
        credentials && credentials.api_key,
        credentials && credentials.token,
        credentials && credentials.access_token,
        credentials && credentials.authToken,
      ]),
    }
  }

  function graphQlErrorMessages(parsed) {
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.errors)) return []
    const messages = []
    for (let i = 0; i < parsed.errors.length && messages.length < 3; i += 1) {
      const message = readString(parsed.errors[i] && parsed.errors[i].message)
      if (message) messages.push(message)
    }
    return messages
  }

  function errorDetail(ctx, bodyText) {
    const parsed = ctx.util.tryParseJson(bodyText)
    const graphQlMessages = graphQlErrorMessages(parsed)
    if (graphQlMessages.length) return graphQlMessages.join(" | ")
    if (!parsed || typeof parsed !== "object") return null
    return readString(parsed.message) || readString(parsed.error) || readString(parsed.error && parsed.error.message)
  }

  function requestBody() {
    return JSON.stringify({
      operationName: "GetRequestLimitInfo",
      query: GRAPHQL_QUERY,
      variables: {
        requestContext: {
          clientContext: {},
          osContext: {
            category: "macOS",
            name: "macOS",
            version: "15.0.0",
          },
        },
      },
    })
  }

  function requestJson(ctx, apiKey) {
    let resp
    try {
      resp = ctx.util.request({
        method: "POST",
        url: API_URL,
        headers: {
          Authorization: authHeader(apiKey),
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "Warp/1.0",
          "x-warp-client-id": "warp-app",
          "x-warp-os-category": "macOS",
          "x-warp-os-name": "macOS",
          "x-warp-os-version": "15.0.0",
        },
        bodyText: requestBody(),
        timeoutMs: 10000,
      })
    } catch (e) {
      ctx.host.log.warn("request failed: " + String(e))
      throw "Request failed. Check your connection."
    }

    const parsed = ctx.util.tryParseJson(resp.bodyText)

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "Warp API key is invalid or expired."
    }

    if (resp.status < 200 || resp.status >= 300) {
      const detail = errorDetail(ctx, resp.bodyText)
      if (detail) throw "Warp API error: " + detail
      throw "Warp request failed (HTTP " + resp.status + "). Try again later."
    }

    const graphQlMessages = graphQlErrorMessages(parsed)
    if (graphQlMessages.length) {
      throw "Warp API error: " + graphQlMessages.join(" | ")
    }

    if (!parsed || typeof parsed !== "object") {
      throw "Warp response invalid. Try again later."
    }
    return parsed
  }

  function sumGrantCredits(grants, totals) {
    if (!Array.isArray(grants)) return
    for (let i = 0; i < grants.length; i += 1) {
      const grant = grants[i]
      if (!grant || typeof grant !== "object") continue
      totals.total += readNumber(grant.requestCreditsGranted) || 0
      totals.remaining += readNumber(grant.requestCreditsRemaining) || 0
    }
  }

  function parseSnapshot(root) {
    const data = root && root.data && typeof root.data === "object" ? root.data : null
    const userOutput = data && data.user && typeof data.user === "object" ? data.user : null
    const user = userOutput && userOutput.user && typeof userOutput.user === "object" ? userOutput.user : null
    if (!user) throw "Unable to extract user data from Warp response."

    const limitInfo = user.requestLimitInfo && typeof user.requestLimitInfo === "object" ? user.requestLimitInfo : null
    if (!limitInfo) throw "Unable to extract requestLimitInfo from Warp response."

    const bonus = { total: 0, remaining: 0 }
    sumGrantCredits(user.bonusGrants, bonus)

    const workspaces = Array.isArray(user.workspaces) ? user.workspaces : []
    for (let i = 0; i < workspaces.length; i += 1) {
      const workspace = workspaces[i]
      const grantsInfo = workspace && workspace.bonusGrantsInfo
      sumGrantCredits(grantsInfo && grantsInfo.grants, bonus)
    }

    return {
      requestLimit: readNumber(limitInfo.requestLimit) || 0,
      requestsUsed: readNumber(limitInfo.requestsUsedSinceLastRefresh) || 0,
      nextRefreshTime: readString(limitInfo.nextRefreshTime),
      isUnlimited: limitInfo.isUnlimited === true,
      bonusCreditsTotal: bonus.total,
      bonusCreditsRemaining: bonus.remaining,
    }
  }

  function addUsageLine(ctx, lines, snapshot) {
    if (snapshot.isUnlimited) {
      lines.push(ctx.line.badge({ label: "Status", text: "Unlimited", color: "#22c55e" }))
      return "Unlimited"
    }

    if (snapshot.requestLimit <= 0) return null

    const used = clampPercent((snapshot.requestsUsed / snapshot.requestLimit) * 100)
    const opts = {
      label: "Credits",
      used,
      limit: 100,
      format: { kind: "percent" },
      periodDurationMs: PERIOD_24_HOURS_MS,
    }
    const resetsAt = snapshot.nextRefreshTime ? ctx.util.toIso(snapshot.nextRefreshTime) : null
    if (resetsAt) opts.resetsAt = resetsAt
    lines.push(ctx.line.progress(opts))
    return null
  }

  function addBonusLine(ctx, lines, snapshot) {
    if (snapshot.bonusCreditsTotal <= 0 && snapshot.bonusCreditsRemaining <= 0) return

    let used = 100
    if (snapshot.bonusCreditsTotal > 0) {
      used = ((snapshot.bonusCreditsTotal - snapshot.bonusCreditsRemaining) / snapshot.bonusCreditsTotal) * 100
    } else if (snapshot.bonusCreditsRemaining > 0) {
      used = 0
    }

    lines.push(ctx.line.progress({
      label: "Add-on Credits",
      used: clampPercent(used),
      limit: 100,
      format: { kind: "percent" },
    }))
  }

  function probe(ctx) {
    const credentials = loadCredentials(ctx)
    if (!credentials.apiKey) {
      throw "Warp API key missing. Add a Warp account in Settings."
    }

    const parsed = requestJson(ctx, credentials.apiKey)
    const snapshot = parseSnapshot(parsed)
    const lines = []
    const plan = addUsageLine(ctx, lines, snapshot)
    addBonusLine(ctx, lines, snapshot)

    if (lines.length === 0) {
      lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))
    }

    return { plan, lines }
  }

  globalThis.__openusage_plugin = { id: "warp", probe }
})()
