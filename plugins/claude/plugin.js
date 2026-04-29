(function () {
  const PROD_BASE_API_URL = "https://api.anthropic.com"
  const PROD_REFRESH_URL = "https://console.anthropic.com/v1/oauth/token"
  const PROD_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
  const NON_PROD_CLIENT_ID = "22422756-60c9-4084-8eb7-27705fd5cf9a"
  const PROMOCLOCK_STATUS_URL = "https://promoclock.co/api/status"
  const PROMOCLOCK_PEAK_COLOR = "#ef4444"
  const PROMOCLOCK_OFF_PEAK_COLOR = "#22c55e"
  const SCOPES =
    "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload"
  const REFRESH_BUFFER_MS = 5 * 60 * 1000 // refresh 5 minutes before expiration

  // Rate-limit state persisted across probe() calls (module scope survives re-invocations).
  const MIN_USAGE_FETCH_INTERVAL_MS = 5 * 60 * 1000  // never poll more than once per 5 min
  const DEFAULT_RATE_LIMIT_BACKOFF_MS = 5 * 60 * 1000 // fallback when no Retry-After header
  let rateLimitedUntilMs = 0  // epoch ms; 0 = not rate-limited
  let lastUsageFetchMs = 0    // epoch ms of the most-recent API attempt
  let cachedUsageData = null  // last successful API response body (parsed JSON)

  function readEnvText(ctx, name) {
    try {
      const value = ctx.host.env.get(name)
      if (value === null || value === undefined) return null
      const text = String(value).trim()
      return text || null
    } catch {
      return null
    }
  }

  function readEnvFlag(ctx, name) {
    const value = readEnvText(ctx, name)
    if (!value) return false
    const lower = value.toLowerCase()
    return lower !== "0" && lower !== "false" && lower !== "no" && lower !== "off"
  }

  function getClaudeHomeOverride(ctx) {
    return readEnvText(ctx, "CLAUDE_CONFIG_DIR")
  }

  function getOauthConfig(ctx) {
    let baseApiUrl = PROD_BASE_API_URL
    let refreshUrl = PROD_REFRESH_URL
    let clientId = PROD_CLIENT_ID
    let oauthFileSuffix = ""

    const isAntUser = readEnvText(ctx, "USER_TYPE") === "ant"
    if (isAntUser && readEnvFlag(ctx, "USE_LOCAL_OAUTH")) {
      const localApiBase = readEnvText(ctx, "CLAUDE_LOCAL_OAUTH_API_BASE")
      baseApiUrl = (localApiBase || "http://localhost:8000").replace(/\/+$/, "")
      refreshUrl = baseApiUrl + "/v1/oauth/token"
      clientId = NON_PROD_CLIENT_ID
      oauthFileSuffix = "-local-oauth"
    } else if (isAntUser && readEnvFlag(ctx, "USE_STAGING_OAUTH")) {
      baseApiUrl = "https://api-staging.anthropic.com"
      refreshUrl = "https://platform.staging.ant.dev/v1/oauth/token"
      clientId = NON_PROD_CLIENT_ID
      oauthFileSuffix = "-staging-oauth"
    }

    const customOauthBase = readEnvText(ctx, "CLAUDE_CODE_CUSTOM_OAUTH_URL")
    if (customOauthBase) {
      const base = customOauthBase.replace(/\/+$/, "")
      baseApiUrl = base
      refreshUrl = base + "/v1/oauth/token"
      oauthFileSuffix = "-custom-oauth"
    }

    const clientIdOverride = readEnvText(ctx, "CLAUDE_CODE_OAUTH_CLIENT_ID")
    if (clientIdOverride) {
      clientId = clientIdOverride
    }

    return {
      baseApiUrl: baseApiUrl,
      usageUrl: baseApiUrl + "/api/oauth/usage",
      refreshUrl: refreshUrl,
      clientId: clientId,
      oauthFileSuffix: oauthFileSuffix,
    }
  }

  function normalizeExpiresAtMs(value) {
    const numberValue = Number(value)
    if (!Number.isFinite(numberValue) || numberValue <= 0) return undefined
    return numberValue < 100000000000 ? numberValue * 1000 : numberValue
  }

  function loadAccountCredentials(ctx) {
    const creds = ctx.credentials
    if (!creds || typeof creds !== "object") return null
    if (!creds.accessToken && !creds.refreshToken) return null

    const oauth = {
      accessToken: creds.accessToken || "",
      refreshToken: creds.refreshToken || "",
      expiresAt: normalizeExpiresAtMs(creds.expiresAt),
      subscriptionType: creds.subscriptionType || creds.subscription_type || null,
      rateLimitTier: creds.rateLimitTier || creds.rate_limit_tier || null,
    }
    if (Array.isArray(creds.scopes)) {
      oauth.scopes = creds.scopes
    } else if (typeof creds.scope === "string") {
      oauth.scopes = creds.scope.split(/\s+/).filter(Boolean)
    }

    return {
      oauth: oauth,
      inferenceOnly: creds.inferenceOnly === true,
    }
  }

  function loadCredentials(ctx) {
    return loadAccountCredentials(ctx)
  }

  function hasProfileScope(creds) {
    if (!creds || creds.inferenceOnly) {
      return false
    }
    const scopes = creds.oauth && creds.oauth.scopes
    if (Array.isArray(scopes) && scopes.length > 0) {
      return scopes.indexOf("user:profile") !== -1
    }
    return true
  }

  function needsRefresh(ctx, oauth, nowMs) {
    return ctx.util.needsRefreshByExpiry({
      nowMs,
      expiresAtMs: oauth.expiresAt,
      bufferMs: REFRESH_BUFFER_MS,
    })
  }

  function refreshToken(ctx, creds) {
    const { oauth } = creds
    if (!oauth.refreshToken) {
      ctx.host.log.warn("refresh skipped: no refresh token")
      return null
    }

    const oauthConfig = getOauthConfig(ctx)
    ctx.host.log.info("attempting token refresh")
    try {
      const resp = ctx.util.request({
        method: "POST",
        url: oauthConfig.refreshUrl,
        headers: { "Content-Type": "application/json" },
        bodyText: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: oauth.refreshToken,
          client_id: oauthConfig.clientId,
          scope: SCOPES,
        }),
        timeoutMs: 15000,
      })

      if (resp.status === 400 || resp.status === 401) {
        let errorCode = null
        const body = ctx.util.tryParseJson(resp.bodyText)
        if (body) errorCode = body.error || body.error_description
        ctx.host.log.error("refresh failed: status=" + resp.status + " error=" + String(errorCode))
        if (errorCode === "invalid_grant") {
          throw "Session expired. Run `claude` to log in again."
        }
        throw "Token expired. Run `claude` to log in again."
      }
      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.warn("refresh returned unexpected status: " + resp.status)
        return null
      }

      const body = ctx.util.tryParseJson(resp.bodyText)
      if (!body) {
        ctx.host.log.warn("refresh response not valid JSON")
        return null
      }
      const newAccessToken = body.access_token
      if (!newAccessToken) {
        ctx.host.log.warn("refresh response missing access_token")
        return null
      }

      // Update oauth credentials
      oauth.accessToken = newAccessToken
      if (body.refresh_token) oauth.refreshToken = body.refresh_token
      if (typeof body.expires_in === "number") {
        oauth.expiresAt = Date.now() + body.expires_in * 1000
      }

      ctx.host.log.info("refresh succeeded, new token expires in " + (body.expires_in || "unknown") + "s")
      return newAccessToken
    } catch (e) {
      if (typeof e === "string") throw e
      ctx.host.log.error("refresh exception: " + String(e))
      return null
    }
  }

  function fetchUsage(ctx, accessToken) {
    const oauthConfig = getOauthConfig(ctx)
    return ctx.util.request({
      method: "GET",
      url: oauthConfig.usageUrl,
      headers: {
        Authorization: "Bearer " + accessToken.trim(),
        Accept: "application/json",
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.69",
      },
      timeoutMs: 10000,
    })
  }

  function parseRetryAfterSeconds(headers) {
    if (!headers) return null
    const raw = headers["retry-after"] ?? headers["Retry-After"]
    if (raw === undefined || raw === null) return null
    const str = String(raw).trim()
    if (!str) return null
    // Retry-After can be a delay-seconds or HTTP-date (RFC 7231).
    // 0 means "retry immediately" — return 0 as a valid value.
    const seconds = parseInt(str, 10)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds
    const dateMs = Date.parse(str)
    if (Number.isFinite(dateMs)) {
      const delay = Math.ceil((dateMs - Date.now()) / 1000)
      return delay > 0 ? delay : 0
    }
    return null
  }

  function fmtRateLimitMinutes(seconds) {
    if (seconds <= 0) return "now"
    const mins = Math.ceil(seconds / 60)
    return mins + "m"
  }

  function queryTokenUsage(ctx, homePath) {
    const since = new Date()
    // Inclusive range: today + previous 30 days = 31 calendar days.
    since.setDate(since.getDate() - 30)
    const y = since.getFullYear()
    const m = since.getMonth() + 1
    const d = since.getDate()
    const sinceStr = "" + y + (m < 10 ? "0" : "") + m + (d < 10 ? "0" : "") + d

    const queryOpts = { since: sinceStr }
    if (homePath) {
      queryOpts.homePath = homePath
    }

    const result = ctx.host.ccusage.query(queryOpts)
    if (!result || typeof result !== "object" || typeof result.status !== "string") {
      return { status: "runner_failed", data: null }
    }
    if (result.status !== "ok") {
      return { status: result.status, data: null }
    }
    if (!result.data || !Array.isArray(result.data.daily)) {
      return { status: "runner_failed", data: null }
    }
    return { status: "ok", data: result.data }
  }

  function fmtTokens(n) {
    const abs = Math.abs(n)
    const sign = n < 0 ? "-" : ""
    const units = [
      { threshold: 1e9, divisor: 1e9, suffix: "B" },
      { threshold: 1e6, divisor: 1e6, suffix: "M" },
      { threshold: 1e3, divisor: 1e3, suffix: "K" },
    ]
    for (let i = 0; i < units.length; i++) {
      const unit = units[i]
      if (abs >= unit.threshold) {
        const scaled = abs / unit.divisor
        const formatted = scaled >= 10
          ? Math.round(scaled).toString()
          : scaled.toFixed(1).replace(/\.0$/, "")
        return sign + formatted + unit.suffix
      }
    }
    return sign + Math.round(abs).toString()
  }

  function dayKeyFromDate(date) {
    const year = date.getFullYear()
    const month = date.getMonth() + 1
    const day = date.getDate()
    return year + "-" + (month < 10 ? "0" : "") + month + "-" + (day < 10 ? "0" : "") + day
  }

  function dayKeyFromUsageDate(rawDate) {
    if (typeof rawDate !== "string") return null
    const value = rawDate.trim()
    if (!value) return null

    const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (isoMatch) {
      return isoMatch[1] + "-" + isoMatch[2] + "-" + isoMatch[3]
    }

    const isoDatePrefixMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[Tt\s]|$)/)
    if (isoDatePrefixMatch) {
      return isoDatePrefixMatch[1] + "-" + isoDatePrefixMatch[2] + "-" + isoDatePrefixMatch[3]
    }

    const compactMatch = value.match(/^(\d{4})(\d{2})(\d{2})$/)
    if (compactMatch) {
      return compactMatch[1] + "-" + compactMatch[2] + "-" + compactMatch[3]
    }

    const ms = Date.parse(value)
    if (!Number.isFinite(ms)) return null
    return dayKeyFromDate(new Date(ms))
  }

  function usageCostUsd(day) {
    if (!day || typeof day !== "object") return null

    if (day.totalCost != null) {
      const totalCost = Number(day.totalCost)
      if (Number.isFinite(totalCost)) return totalCost
    }

    if (day.costUSD != null) {
      const costUSD = Number(day.costUSD)
      if (Number.isFinite(costUSD)) return costUSD
    }

    return null
  }

  function costAndTokensLabel(data, opts) {
    const includeZeroTokens = !!(opts && opts.includeZeroTokens)
    const parts = []
    if (data.costUSD != null) parts.push("$" + data.costUSD.toFixed(2))
    if (data.tokens > 0 || (includeZeroTokens && data.tokens === 0)) {
      parts.push(fmtTokens(data.tokens) + " tokens")
    }
    return parts.join(" \u00b7 ")
  }

  function pushDayUsageLine(lines, ctx, label, dayEntry) {
    const tokens = Number(dayEntry && dayEntry.totalTokens) || 0
    const cost = usageCostUsd(dayEntry)
    if (tokens > 0) {
      lines.push(ctx.line.text({
        label: label,
        value: costAndTokensLabel({ tokens: tokens, costUSD: cost })
      }))
      return
    }

    lines.push(ctx.line.text({
      label: label,
      value: costAndTokensLabel({ tokens: 0, costUSD: 0 }, { includeZeroTokens: true })
    }))
  }

  function getPromoClockBadgeText(data) {
    if (!data || typeof data !== "object") return null
    if (data.isPeak === true) return "Peak"
    if (data.isOffPeak === true || data.isWeekend === true) return "Off-Peak"

    const status = typeof data.status === "string" ? data.status.trim().toLowerCase() : ""
    if (status === "peak") return "Peak"
    if (status === "off_peak" || status === "off-peak" || status === "weekend") return "Off-Peak"
    return null
  }

  function getPromoClockColor(badgeText) {
    if (badgeText === "Peak") return PROMOCLOCK_PEAK_COLOR
    if (badgeText === "Off-Peak") return PROMOCLOCK_OFF_PEAK_COLOR
    return null
  }

  function fetchPromoClockLine(ctx) {
    let resp
    let json
    try {
      const result = ctx.util.requestJson({
        method: "GET",
        url: PROMOCLOCK_STATUS_URL,
        headers: {
          Accept: "application/json",
        },
        timeoutMs: 2000,
      })
      resp = result.resp
      json = result.json
    } catch (e) {
      ctx.host.log.warn("promoclock request failed: " + String(e))
      return null
    }

    if (!resp || resp.status < 200 || resp.status >= 300) {
      ctx.host.log.warn("promoclock returned unexpected status: " + String(resp && resp.status))
      return null
    }

    if (!json || typeof json !== "object") {
      ctx.host.log.warn("promoclock response invalid")
      return null
    }

    const badgeText = getPromoClockBadgeText(json)

    if (!badgeText) {
      ctx.host.log.warn("promoclock response missing expected fields")
      return null
    }

    return ctx.line.badge({
      label: "Peak Hours",
      text: badgeText,
      color: getPromoClockColor(badgeText),
    })
  }

  function probe(ctx) {
    const creds = loadCredentials(ctx)
    if (!creds || !creds.oauth || !creds.oauth.accessToken || !creds.oauth.accessToken.trim()) {
      ctx.host.log.error("probe failed: not logged in")
      throw "Not logged in. Run `claude` to authenticate."
    }

    const nowMs = Date.now()
    let accessToken = creds.oauth.accessToken
    const homePath = getClaudeHomeOverride(ctx)
    const canFetchLiveUsage = hasProfileScope(creds)

    let data = null
    let lines = []
    let rateLimited = false
    let retryAfterSeconds = null
    if (canFetchLiveUsage) {
      if (nowMs < rateLimitedUntilMs) {
        // Still within a rate-limit window from a previous probe call — skip the
        // API request entirely and surface the remaining wait time to the user.
        rateLimited = true
        retryAfterSeconds = Math.ceil((rateLimitedUntilMs - nowMs) / 1000)
        data = cachedUsageData
        ctx.host.log.info("usage fetch skipped: rate-limited for " + retryAfterSeconds + "s more")
      } else {
        // Rate-limit window has expired (or was never set).  Check whether we were
        // previously rate-limited so we can bypass the min-interval guard: a short
        // Retry-After (< 5 min) must not be swallowed by the normal poll throttle.
        const wasRateLimited = rateLimitedUntilMs > 0
        rateLimitedUntilMs = 0

        if (!wasRateLimited && nowMs - lastUsageFetchMs < MIN_USAGE_FETCH_INTERVAL_MS) {
          // Polled too recently in normal operation — reuse last cached response.
          data = cachedUsageData
          ctx.host.log.info(
            "usage fetch skipped: last fetch was " +
            Math.round((nowMs - lastUsageFetchMs) / 1000) + "s ago (min interval " +
            MIN_USAGE_FETCH_INTERVAL_MS / 1000 + "s)"
          )
        } else {
        // Proactively refresh if token is expired or about to expire
        if (needsRefresh(ctx, creds.oauth, nowMs)) {
          ctx.host.log.info("token needs refresh (expired or expiring soon)")
          const refreshed = refreshToken(ctx, creds)
          if (refreshed) {
            accessToken = refreshed
          } else {
            ctx.host.log.warn("proactive refresh failed, trying with existing token")
          }
        }

        lastUsageFetchMs = nowMs
        let resp
        let didRefresh = false
        try {
          resp = ctx.util.retryOnceOnAuth({
            request: (token) => {
              try {
                return fetchUsage(ctx, token || accessToken)
              } catch (e) {
                ctx.host.log.error("usage request exception: " + String(e))
                if (didRefresh) {
                  throw "Usage request failed after refresh. Try again."
                }
                throw "Usage request failed. Check your connection."
              }
            },
            refresh: () => {
              ctx.host.log.info("usage returned 401, attempting refresh")
              didRefresh = true
              return refreshToken(ctx, creds)
            },
          })
        } catch (e) {
          if (typeof e === "string") throw e
          ctx.host.log.error("usage request failed: " + String(e))
          throw "Usage request failed. Check your connection."
        }

        if (ctx.util.isAuthStatus(resp.status)) {
          ctx.host.log.error("usage returned auth error after all retries: status=" + resp.status)
          throw "Token expired. Run `claude` to log in again."
        }

        if (resp.status === 429) {
          rateLimited = true
          retryAfterSeconds = parseRetryAfterSeconds(resp.headers)
          const backoffMs = retryAfterSeconds !== null
            ? retryAfterSeconds * 1000
            : DEFAULT_RATE_LIMIT_BACKOFF_MS
          rateLimitedUntilMs = nowMs + backoffMs
          data = cachedUsageData
          ctx.host.log.warn(
            "usage rate limited (429), backing off for " +
            Math.round(backoffMs / 1000) + "s"
          )
        } else if (resp.status < 200 || resp.status >= 300) {
          ctx.host.log.error("usage returned error: status=" + resp.status)
          throw "Usage request failed (HTTP " + String(resp.status) + "). Try again later."
        } else {
          ctx.host.log.info("usage fetch succeeded")
          data = ctx.util.tryParseJson(resp.bodyText)
          if (data === null) {
            throw "Usage response invalid. Try again later."
          }
          cachedUsageData = data
          rateLimitedUntilMs = 0
        }
        } // end fetch else-branch
      }
    } else {
      ctx.host.log.info("skipping live usage fetch for inference-only token")
    }

    let plan = null
    if (creds.oauth.subscriptionType) {
      const basePlan = ctx.fmt.planLabel(creds.oauth.subscriptionType)
      if (basePlan) {
        let tierSuffix = ""
        const rlt = String(creds.oauth.rateLimitTier || "")
        const tierMatch = rlt.match(/(\d+)x/)
        if (tierMatch) {
          tierSuffix = " " + tierMatch[1] + "x"
        }
        plan = basePlan + tierSuffix
      }
    }

    if (data) {
      if (data.five_hour && typeof data.five_hour.utilization === "number") {
        lines.push(ctx.line.progress({
          label: "Session",
          used: data.five_hour.utilization,
          limit: 100,
          format: { kind: "percent" },
          resetsAt: ctx.util.toIso(data.five_hour.resets_at),
          periodDurationMs: 5 * 60 * 60 * 1000 // 5 hours
        }))
      }
      if (data.seven_day && typeof data.seven_day.utilization === "number") {
        lines.push(ctx.line.progress({
          label: "Weekly",
          used: data.seven_day.utilization,
          limit: 100,
          format: { kind: "percent" },
          resetsAt: ctx.util.toIso(data.seven_day.resets_at),
          periodDurationMs: 7 * 24 * 60 * 60 * 1000 // 7 days
        }))
      }
      if (data.seven_day_sonnet && typeof data.seven_day_sonnet.utilization === "number") {
        lines.push(ctx.line.progress({
          label: "Sonnet",
          used: data.seven_day_sonnet.utilization,
          limit: 100,
          format: { kind: "percent" },
          resetsAt: ctx.util.toIso(data.seven_day_sonnet.resets_at),
          periodDurationMs: 7 * 24 * 60 * 60 * 1000 // 7 days
        }))
      }
      if (data.seven_day_omelette && typeof data.seven_day_omelette.utilization === "number") {
        lines.push(ctx.line.progress({
          label: "Claude Design",
          used: data.seven_day_omelette.utilization,
          limit: 100,
          format: { kind: "percent" },
          resetsAt: ctx.util.toIso(data.seven_day_omelette.resets_at),
          periodDurationMs: 7 * 24 * 60 * 60 * 1000 // 7 days
        }))
      }

      if (data.extra_usage && data.extra_usage.is_enabled) {
        const used = data.extra_usage.used_credits
        const limit = data.extra_usage.monthly_limit
        if (typeof used === "number" && typeof limit === "number" && limit > 0) {
          lines.push(ctx.line.progress({
            label: "Extra usage spent",
            used: ctx.fmt.dollars(used),
            limit: ctx.fmt.dollars(limit),
            format: { kind: "dollars" }
          }))
        } else if (typeof used === "number" && used > 0) {
          lines.push(ctx.line.text({ label: "Extra usage spent", value: "$" + String(ctx.fmt.dollars(used)) }))
        }
      }
    }

    const usageResult = queryTokenUsage(ctx, homePath)
    if (usageResult.status === "ok") {
      const usage = usageResult.data
      const now = new Date()
      const todayKey = dayKeyFromDate(now)
      const yesterday = new Date(now.getTime())
      yesterday.setDate(yesterday.getDate() - 1)
      const yesterdayKey = dayKeyFromDate(yesterday)

      let todayEntry = null
      let yesterdayEntry = null
      for (let i = 0; i < usage.daily.length; i++) {
        const usageDayKey = dayKeyFromUsageDate(usage.daily[i].date)
        if (usageDayKey === todayKey) {
          todayEntry = usage.daily[i]
          continue
        }
        if (usageDayKey === yesterdayKey) {
          yesterdayEntry = usage.daily[i]
        }
      }

      pushDayUsageLine(lines, ctx, "Today", todayEntry)
      pushDayUsageLine(lines, ctx, "Yesterday", yesterdayEntry)

      let totalTokens = 0
      let totalCostNanos = 0
      let hasCost = false
      for (let i = 0; i < usage.daily.length; i++) {
        const day = usage.daily[i]
        const dayTokens = Number(day.totalTokens)
        if (Number.isFinite(dayTokens)) {
          totalTokens += dayTokens
        }
        const dayCost = usageCostUsd(day)
        if (dayCost != null) {
          totalCostNanos += Math.round(dayCost * 1e9)
          hasCost = true
        }
      }
      if (totalTokens > 0) {
        lines.push(ctx.line.text({
          label: "Last 30 Days",
          value: costAndTokensLabel({ tokens: totalTokens, costUSD: hasCost ? totalCostNanos / 1e9 : null })
        }))
      }
    }

    const promoClockLine = fetchPromoClockLine(ctx)

    if (rateLimited) {
      const retryText = retryAfterSeconds !== null
        ? fmtRateLimitMinutes(retryAfterSeconds)
        : null
      const waitText = retryText
        ? "Rate limited, retry in ~" + retryText
        : "Rate limited, try again later"
      lines.unshift(ctx.line.badge({ label: "Status", text: waitText, color: "#f59e0b" }))
      const noteText = retryText
        ? "Live usage rate limited — retry in ~" + retryText
        : "Live usage rate limited — data may be stale"
      lines.push(ctx.line.text({ label: "Note", value: noteText }))
    } else if (lines.length === 0) {
      lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))
    }

    if (promoClockLine) lines.push(promoClockLine)

    const result = { plan: plan, lines: lines }
    result.updatedCredentialsJson = JSON.stringify({
      type: "oauth",
      accessToken: creds.oauth.accessToken || "",
      refreshToken: creds.oauth.refreshToken || "",
      expiresAt: creds.oauth.expiresAt ? Math.floor(Number(creds.oauth.expiresAt) / 1000) : null,
      scope: Array.isArray(creds.oauth.scopes) ? creds.oauth.scopes.join(" ") : null,
      subscriptionType: creds.oauth.subscriptionType || null,
      rateLimitTier: creds.oauth.rateLimitTier || null,
      inferenceOnly: creds.inferenceOnly === true,
    })
    return result
  }

  // _resetState is a testing hook — resets module-scope rate-limit state between tests.
  // The production host never calls this.
  function _resetState() {
    rateLimitedUntilMs = 0
    lastUsageFetchMs = 0
    cachedUsageData = null
  }

  globalThis.__openusage_plugin = { id: "claude", probe, _resetState }
})()
