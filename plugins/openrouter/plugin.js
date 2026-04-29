(function () {
  const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"
  const CREDITS_PATH = "credits"
  const KEY_PATH = "key"

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

  function withScheme(raw) {
    const value = readString(raw)
    if (!value) return null
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
    return "https://" + value
  }

  function joinUrl(baseUrl, path) {
    const base = withScheme(baseUrl) || DEFAULT_BASE_URL
    return base.replace(/\/+$/, "") + "/" + path
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
      apiHost: pickString([credentials && credentials.apiHost, credentials && credentials.api_host, credentials && credentials.api_url]),
    }
  }

  function errorDetail(bodyText) {
    const parsed = this && this.util ? this.util.tryParseJson(bodyText) : null
    if (!parsed || typeof parsed !== "object") return null
    return readString(parsed.message) || readString(parsed.detail) || readString(parsed.error && parsed.error.message)
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
      throw "OpenRouter API key is invalid or expired."
    }

    if (resp.status < 200 || resp.status >= 300) {
      const detail = errorDetail.call(ctx, resp.bodyText)
      if (detail) throw "OpenRouter API error: " + detail
      throw "Request failed (HTTP " + resp.status + "). Try again later."
    }

    const parsed = ctx.util.tryParseJson(resp.bodyText)
    if (!parsed || typeof parsed !== "object") {
      throw "OpenRouter response invalid. Try again later."
    }
    return parsed
  }

  function fetchCredits(ctx, credentials) {
    const baseUrl = credentials.apiHost || DEFAULT_BASE_URL
    return requestJson(ctx, {
      method: "GET",
      url: joinUrl(baseUrl, CREDITS_PATH),
      headers: {
        Authorization: authHeader(credentials.apiKey),
        Accept: "application/json",
        "User-Agent": "openusage",
        "X-Title": "OpenUsage",
      },
      timeoutMs: 10000,
    })
  }

  function fetchKeyData(ctx, credentials) {
    const baseUrl = credentials.apiHost || DEFAULT_BASE_URL
    try {
      const parsed = requestJson(ctx, {
        method: "GET",
        url: joinUrl(baseUrl, KEY_PATH),
        headers: {
          Authorization: authHeader(credentials.apiKey),
          Accept: "application/json",
          "User-Agent": "openusage",
          "X-Title": "OpenUsage",
        },
        timeoutMs: 3000,
      })
      return parsed.data && typeof parsed.data === "object" ? parsed.data : null
    } catch (e) {
      ctx.host.log.warn("key metadata request ignored: " + String(e))
      return null
    }
  }

  function probe(ctx) {
    const credentials = loadCredentials(ctx)
    if (!credentials.apiKey) {
      throw "OpenRouter API key missing. Add an OpenRouter account in Settings."
    }

    const credits = fetchCredits(ctx, credentials)
    const data = credits.data && typeof credits.data === "object" ? credits.data : null
    if (!data) {
      throw "OpenRouter credits response missing data. Try again later."
    }

    const totalCredits = readNumber(data.total_credits) || 0
    const totalUsage = readNumber(data.total_usage) || 0
    const balance = Math.max(0, totalCredits - totalUsage)
    const keyData = fetchKeyData(ctx, credentials)
    const lines = []

    if (totalCredits > 0 || balance > 0) {
      lines.push(ctx.line.progress({
        label: "Credits",
        used: totalUsage,
        limit: totalCredits,
        format: { kind: "dollars" },
      }))
    }

    const keyLimit = keyData ? readNumber(keyData.limit) : null
    const keyUsage = keyData ? readNumber(keyData.usage) : null
    if (keyLimit !== null && keyUsage !== null && keyLimit > 0) {
      lines.push(ctx.line.progress({
        label: "Key Quota",
        used: keyUsage,
        limit: keyLimit,
        format: { kind: "dollars" },
      }))
    }

    const rateLimit = keyData && keyData.rate_limit && typeof keyData.rate_limit === "object" ? keyData.rate_limit : null
    const requests = rateLimit ? readNumber(rateLimit.requests) : null
    const interval = rateLimit ? readString(rateLimit.interval) : null
    if (requests !== null) {
      lines.push(ctx.line.text({
        label: "Rate Limit",
        value: String(Math.round(requests)) + " req/" + (interval || "period"),
      }))
    }

    if (lines.length === 0) {
      lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))
    }

    const label = keyData ? readString(keyData.label) : null
    const plan = label ? ctx.fmt.planLabel(label) : null
    return { plan, lines }
  }

  globalThis.__openusage_plugin = { id: "openrouter", probe }
})()
