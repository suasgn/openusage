(function () {
  const CREDITS_URL = "https://kimi-k2.ai/api/user/credits"

  const CONSUMED_PATHS = [
    ["total_credits_consumed"],
    ["totalCreditsConsumed"],
    ["total_credits_used"],
    ["totalCreditsUsed"],
    ["credits_consumed"],
    ["creditsConsumed"],
    ["consumedCredits"],
    ["usedCredits"],
    ["total"],
    ["usage", "total"],
    ["usage", "consumed"],
  ]
  const REMAINING_PATHS = [
    ["credits_remaining"],
    ["creditsRemaining"],
    ["remaining_credits"],
    ["remainingCredits"],
    ["available_credits"],
    ["availableCredits"],
    ["credits_left"],
    ["creditsLeft"],
    ["usage", "credits_remaining"],
    ["usage", "remaining"],
  ]
  const AVERAGE_TOKEN_PATHS = [
    ["average_tokens_per_request"],
    ["averageTokensPerRequest"],
    ["average_tokens"],
    ["averageTokens"],
    ["avg_tokens"],
    ["avgTokens"],
  ]

  function readString(value) {
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }

  function readNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (typeof value !== "string") return null
    const trimmed = value.trim().replace(/,/g, "")
    if (!trimmed) return null
    const n = Number(trimmed)
    return Number.isFinite(n) ? n : null
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

  function errorDetail(ctx, bodyText) {
    const parsed = ctx.util.tryParseJson(bodyText)
    if (!parsed || typeof parsed !== "object") return null
    if (typeof parsed.error === "string") return readString(parsed.error)
    return (
      readString(parsed.message) ||
      readString(parsed.detail) ||
      readString(parsed.error && parsed.error.message)
    )
  }

  function requestJson(ctx, opts) {
    let resp
    try {
      resp = ctx.util.request(opts)
    } catch (e) {
      ctx.host.log.warn("request failed: " + String(e))
      throw "Request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "Kimi K2 API key is invalid or expired."
    }

    if (resp.status < 200 || resp.status >= 300) {
      const detail = errorDetail(ctx, resp.bodyText)
      if (detail) throw "Kimi K2 API error: " + detail
      throw "Request failed (HTTP " + resp.status + "). Try again later."
    }

    const parsed = ctx.util.tryParseJson(resp.bodyText)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw "Kimi K2 response invalid. Try again later."
    }
    return { json: parsed, headers: resp.headers || {} }
  }

  function contextsFrom(root) {
    const contexts = [root]
    const wrappers = [root.data, root.result, root.usage, root.credits]
    for (let i = 0; i < wrappers.length; i += 1) {
      const wrapper = wrappers[i]
      if (!wrapper || typeof wrapper !== "object" || Array.isArray(wrapper)) continue
      contexts.push(wrapper)
      if (wrapper.usage && typeof wrapper.usage === "object" && !Array.isArray(wrapper.usage)) contexts.push(wrapper.usage)
      if (wrapper.credits && typeof wrapper.credits === "object" && !Array.isArray(wrapper.credits)) contexts.push(wrapper.credits)
    }
    return contexts
  }

  function valueFor(path, contexts) {
    for (let i = 0; i < contexts.length; i += 1) {
      let cursor = contexts[i]
      for (let j = 0; j < path.length; j += 1) {
        if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) {
          cursor = null
          break
        }
        cursor = cursor[path[j]]
      }
      if (cursor !== null && cursor !== undefined) return cursor
    }
    return null
  }

  function numberFromPaths(paths, contexts) {
    for (let i = 0; i < paths.length; i += 1) {
      const n = readNumber(valueFor(paths[i], contexts))
      if (n !== null) return n
    }
    return null
  }

  function headerNumber(headers, name) {
    const wanted = String(name).toLowerCase()
    for (const key in headers || {}) {
      if (String(key).toLowerCase() === wanted) return readNumber(headers[key])
    }
    return null
  }

  function formatCredits(value) {
    const n = Number(value || 0)
    if (!Number.isFinite(n)) return "0"
    if (Math.abs(n) >= 1000) return formatInteger(Math.round(n))
    if (Math.abs(n - Math.round(n)) < 0.001) return String(Math.round(n))
    return n.toFixed(1)
  }

  function formatInteger(value) {
    const sign = value < 0 ? "-" : ""
    let text = String(Math.abs(value))
    let out = ""
    while (text.length > 3) {
      out = "," + text.slice(-3) + out
      text = text.slice(0, -3)
    }
    return sign + text + out
  }

  function probe(ctx) {
    const credentials = loadCredentials(ctx)
    if (!credentials.apiKey) {
      throw "Kimi K2 API key missing. Add a Kimi K2 account in Settings."
    }

    const result = requestJson(ctx, {
      method: "GET",
      url: CREDITS_URL,
      headers: {
        Authorization: authHeader(credentials.apiKey),
        Accept: "application/json",
        "User-Agent": "openburn",
      },
      timeoutMs: 10000,
    })

    const contexts = contextsFrom(result.json)
    const consumedRaw = numberFromPaths(CONSUMED_PATHS, contexts)
    const remainingRaw = numberFromPaths(REMAINING_PATHS, contexts) ?? headerNumber(result.headers, "x-credits-remaining")
    const averageTokens = numberFromPaths(AVERAGE_TOKEN_PATHS, contexts)

    if (consumedRaw === null && remainingRaw === null) {
      throw "Kimi K2 credits response missing usage data. Try again later."
    }

    const consumed = Math.max(0, consumedRaw || 0)
    const remaining = Math.max(0, remainingRaw || 0)
    const total = consumed + remaining
    const lines = []

    if (total > 0) {
      lines.push(ctx.line.progress({
        label: "Credits",
        used: consumed,
        limit: total,
        format: { kind: "count", suffix: "credits" },
      }))
      lines.push(ctx.line.text({ label: "Remaining", value: formatCredits(remaining) + " credits" }))
    } else {
      lines.push(ctx.line.badge({ label: "Status", text: "No credits", color: "#f59e0b" }))
    }

    if (averageTokens !== null) {
      lines.push(ctx.line.text({ label: "Avg Tokens", value: formatCredits(averageTokens) }))
    }

    return { plan: null, lines }
  }

  globalThis.__openusage_plugin = { id: "kimi-k2", probe }
})()
