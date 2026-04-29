(function () {
  const BASE_URL = "https://api.z.ai"
  const CN_BASE_URL = "https://open.bigmodel.cn"
  const SUBSCRIPTION_PATH = "api/biz/subscription/list"
  const QUOTA_PATH = "api/monitor/usage/quota/limit"
  const PERIOD_MS = 5 * 60 * 60 * 1000
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000
  const MONTH_MS = 30 * 24 * 60 * 60 * 1000

  function readString(value) {
    if (typeof value !== "string") return null
    const trimmed = value.trim()
    return trimmed ? trimmed : null
  }

  function pickString(values) {
    for (let i = 0; i < values.length; i += 1) {
      const value = readString(values[i])
      if (value) return value
    }
    return null
  }

  function stripWrappedQuotes(value) {
    const raw = readString(value)
    if (!raw) return null
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return readString(raw.slice(1, -1))
    }
    return raw
  }

  function withScheme(raw) {
    const value = stripWrappedQuotes(raw)
    if (!value) return null
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
    return "https://" + value
  }

  function baseUrlForRegion(region) {
    const normalized = readString(region)
    if (!normalized) return BASE_URL
    const lower = normalized.toLowerCase()
    if (lower === "bigmodel-cn" || lower === "bigmodelcn" || lower === "cn" || lower === "zhipu") {
      return CN_BASE_URL
    }
    return BASE_URL
  }

  function appendPathIfHost(raw, path) {
    const url = withScheme(raw)
    if (!url) return null
    if (/^[a-z][a-z0-9+.-]*:\/\/[^/]+\/?$/i.test(url)) {
      return url.replace(/\/+$/, "") + "/" + path
    }
    return url
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
      apiHost: pickString([credentials && credentials.apiHost, credentials && credentials.api_host]),
      quotaUrl: pickString([credentials && credentials.quotaUrl, credentials && credentials.quota_url]),
      apiRegion: pickString([credentials && credentials.apiRegion, credentials && credentials.api_region]),
    }
  }

  function resolveQuotaUrl(credentials) {
    if (credentials.quotaUrl) return appendPathIfHost(credentials.quotaUrl, QUOTA_PATH)
    if (credentials.apiHost) return appendPathIfHost(credentials.apiHost, QUOTA_PATH)
    return appendPathIfHost(baseUrlForRegion(credentials.apiRegion), QUOTA_PATH)
  }

  function resolveSubscriptionUrl(credentials) {
    const baseUrl = credentials.apiHost || baseUrlForRegion(credentials.apiRegion)
    return appendPathIfHost(baseUrl, SUBSCRIPTION_PATH)
  }

  function fetchSubscription(ctx, credentials) {
    const url = resolveSubscriptionUrl(credentials)
    if (!url) return null
    try {
      const resp = ctx.util.request({
        method: "GET",
        url,
        headers: {
          Authorization: authHeader(credentials.apiKey),
          Accept: "application/json",
        },
        timeoutMs: 10000,
      })
      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.warn("subscription request failed: HTTP " + resp.status)
        return null
      }
      const data = ctx.util.tryParseJson(resp.bodyText)
      if (!data) return null
      const list = data.data
      if (!Array.isArray(list) || list.length === 0) return null
      return {
        productName: list[0].productName || null,
        nextRenewTime: list[0].nextRenewTime || null,
      }
    } catch (e) {
      ctx.host.log.warn("subscription request exception: " + String(e))
      return null
    }
  }

  function fetchQuota(ctx, credentials) {
    const url = resolveQuotaUrl(credentials)
    if (!url) throw "Z.ai quota URL invalid. Check your Z.ai account settings."

    let resp
    try {
      resp = ctx.util.request({
        method: "GET",
        url,
        headers: {
          Authorization: authHeader(credentials.apiKey),
          Accept: "application/json",
        },
        timeoutMs: 10000,
      })
    } catch (e) {
      ctx.host.log.error("usage request exception: " + String(e))
      throw "Usage request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "API key invalid. Check your Z.ai API key."
    }

    if (resp.status < 200 || resp.status >= 300) {
      throw "Usage request failed (HTTP " + String(resp.status) + "). Try again later."
    }

    const data = ctx.util.tryParseJson(resp.bodyText)
    if (!data) {
      throw "Usage response invalid. Try again later."
    }

    return data
  }

  function findLimit(limits, type, unit) {
    let fallback = null
    for (let i = 0; i < limits.length; i++) {
      const item = limits[i]
      if (item.type === type || item.name === type) {
        if (unit === undefined) {
          return item
        }
        if (item.unit === unit) {
          return item
        }
        // Store first entry without unit as fallback
        if (fallback === null && item.unit === undefined) {
          fallback = item
        }
      }
    }
    return fallback
  }

  function probe(ctx) {
    const credentials = loadCredentials(ctx)
    if (!credentials.apiKey) {
      throw "Z.ai API key missing. Add a Z.ai account in Settings."
    }

    const sub = fetchSubscription(ctx, credentials)
    const plan = sub && sub.productName ? ctx.fmt.planLabel(sub.productName) : null

    const quota = fetchQuota(ctx, credentials)
    const lines = []

    const container = quota.data || quota
    const limits = container.limits || container
    if (!Array.isArray(limits) || limits.length === 0) {
      lines.push(ctx.line.badge({ label: "Session", text: "No usage data", color: "#a3a3a3" }))
      return { plan, lines }
    }

    const tokenLimit = findLimit(limits, "TOKENS_LIMIT", 3)

    if (!tokenLimit) {
      lines.push(ctx.line.badge({ label: "Session", text: "No usage data", color: "#a3a3a3" }))
      return { plan, lines }
    }

    const used = typeof tokenLimit.percentage === "number" ? tokenLimit.percentage : 0
    const resetsAt = tokenLimit.nextResetTime ? ctx.util.toIso(tokenLimit.nextResetTime) : undefined

    const progressOpts = {
      label: "Session",
      used,
      limit: 100,
      format: { kind: "percent" },
      periodDurationMs: PERIOD_MS,
    }
    if (resetsAt) {
      progressOpts.resetsAt = resetsAt
    }
    lines.push(ctx.line.progress(progressOpts))

    const weeklyTokenLimit = findLimit(limits, "TOKENS_LIMIT", 6)
    if (weeklyTokenLimit) {
      const weeklyUsed = Number.isFinite(weeklyTokenLimit.percentage) ? weeklyTokenLimit.percentage : 0
      const weeklyResetsAt = weeklyTokenLimit.nextResetTime ? ctx.util.toIso(weeklyTokenLimit.nextResetTime) : undefined

      const weeklyOpts = {
        label: "Weekly",
        used: weeklyUsed,
        limit: 100,
        format: { kind: "percent" },
        periodDurationMs: WEEK_MS,
      }
      if (weeklyResetsAt) {
        weeklyOpts.resetsAt = weeklyResetsAt
      }
      lines.push(ctx.line.progress(weeklyOpts))
    }

    const timeLimit = findLimit(limits, "TIME_LIMIT")

    if (timeLimit) {
      const webUsed = typeof timeLimit.currentValue === "number" ? timeLimit.currentValue : 0
      const webTotal = typeof timeLimit.usage === "number" ? timeLimit.usage : 0
      const now = new Date()
      const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
      const webResetsAt = timeLimit.nextResetTime
        ? ctx.util.toIso(timeLimit.nextResetTime)
        : nextMonth.toISOString()

      const webOpts = {
        label: "Web Searches",
        used: webUsed,
        limit: webTotal,
        format: { kind: "count", suffix: "/ " + webTotal },
        periodDurationMs: MONTH_MS,
      }
      if (webResetsAt) {
        webOpts.resetsAt = webResetsAt
      }
      lines.push(ctx.line.progress(webOpts))
    }

    return { plan, lines }
  }

  globalThis.__openusage_plugin = { id: "zai", probe }
})()
