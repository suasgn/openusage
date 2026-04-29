(function () {
  const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
  const REFRESH_URL = "https://auth.openai.com/oauth/token"
  const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
  const REFRESH_AGE_MS = 8 * 24 * 60 * 60 * 1000

  function extractAccountIdFromClaims(claims) {
    if (!claims || typeof claims !== "object") return null
    if (claims.chatgpt_account_id) return claims.chatgpt_account_id
    const openaiAuth = claims["https://api.openai.com/auth"]
    if (openaiAuth && openaiAuth.chatgpt_account_id) return openaiAuth.chatgpt_account_id
    if (Array.isArray(claims.organizations) && claims.organizations.length > 0) {
      const first = claims.organizations[0]
      if (first && first.id) return first.id
    }
    return null
  }

  function extractAccountId(ctx, accessToken, idToken) {
    if (ctx.jwt && typeof ctx.jwt.decodePayload === "function") {
      const idClaims = idToken ? ctx.jwt.decodePayload(idToken) : null
      const idAccount = extractAccountIdFromClaims(idClaims)
      if (idAccount) return idAccount
      const accessClaims = accessToken ? ctx.jwt.decodePayload(accessToken) : null
      return extractAccountIdFromClaims(accessClaims)
    }
    return null
  }

  function loadAccountAuth(ctx) {
    const creds = ctx.credentials
    if (!creds || typeof creds !== "object") return null
    if (creds.accessToken || creds.refreshToken || creds.idToken) {
      const accountId = creds.accountId || extractAccountId(ctx, creds.accessToken, creds.idToken)
      return {
        auth: {
          last_refresh: creds.lastRefresh || new Date().toISOString(),
          tokens: {
            access_token: creds.accessToken || "",
            refresh_token: creds.refreshToken || "",
            id_token: creds.idToken || "",
            account_id: accountId || null,
            expires_at: creds.expiresAt || null,
          },
        },
        source: "account",
      }
    }
    if (creds.apiKey) {
      return { auth: { OPENAI_API_KEY: creds.apiKey }, source: "account" }
    }
    return null
  }

  function loadAuth(ctx) {
    return loadAccountAuth(ctx)
  }

  function needsRefresh(ctx, auth, nowMs) {
    if (auth.tokens && auth.tokens.expires_at) {
      const expiresAt = Number(auth.tokens.expires_at) * 1000
      if (Number.isFinite(expiresAt) && nowMs + 5 * 60 * 1000 >= expiresAt) return true
    }
    if (!auth.last_refresh) return true
    const lastMs = ctx.util.parseDateMs(auth.last_refresh)
    if (lastMs === null) return true
    return nowMs - lastMs > REFRESH_AGE_MS
  }

  function refreshToken(ctx, authState) {
    const auth = authState.auth
    if (!auth.tokens || !auth.tokens.refresh_token) {
      ctx.host.log.warn("refresh skipped: no refresh token")
      return null
    }

    ctx.host.log.info("attempting token refresh")
    try {
      const resp = ctx.util.request({
        method: "POST",
        url: REFRESH_URL,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        bodyText:
          "grant_type=refresh_token" +
          "&client_id=" + encodeURIComponent(CLIENT_ID) +
          "&refresh_token=" + encodeURIComponent(auth.tokens.refresh_token),
        timeoutMs: 15000,
      })

      if (resp.status === 400 || resp.status === 401) {
        let code = null
        const body = ctx.util.tryParseJson(resp.bodyText)
        if (body) {
          code = body.error?.code || body.error || body.code
        }
        ctx.host.log.error("refresh failed: status=" + resp.status + " code=" + String(code))
        if (code === "refresh_token_expired") {
          throw "Session expired. Run `codex` to log in again."
        }
        if (code === "refresh_token_reused") {
          throw "Token conflict. Run `codex` to log in again."
        }
        if (code === "refresh_token_invalidated") {
          throw "Token revoked. Run `codex` to log in again."
        }
        throw "Token expired. Run `codex` to log in again."
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

      auth.tokens.access_token = newAccessToken
      if (body.refresh_token) auth.tokens.refresh_token = body.refresh_token
      if (body.id_token) auth.tokens.id_token = body.id_token
      if (typeof body.expires_in === "number") {
        auth.tokens.expires_at = Math.floor(Date.now() / 1000) + Math.max(1, body.expires_in)
      }
      const accountId = extractAccountId(ctx, auth.tokens.access_token, auth.tokens.id_token)
      if (accountId) auth.tokens.account_id = accountId
      auth.last_refresh = new Date().toISOString()

      return newAccessToken
    } catch (e) {
      if (typeof e === "string") throw e
      ctx.host.log.error("refresh exception: " + String(e))
      return null
    }
  }

  function fetchUsage(ctx, accessToken, accountId) {
    const headers = {
      Authorization: "Bearer " + accessToken,
      Accept: "application/json",
      "User-Agent": "OpenUsage",
    }
    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId
    }
    return ctx.util.request({
      method: "GET",
      url: USAGE_URL,
      headers,
      timeoutMs: 10000,
    })
  }

  function readPercent(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  function readNumber(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  function formatCodexPlan(ctx, planType) {
    const rawPlan = typeof planType === "string" ? planType.trim() : ""
    if (!rawPlan) return null
    if (rawPlan.toLowerCase() === "prolite") return "Pro 5x"
    if (rawPlan.toLowerCase() === "pro") return "Pro 20x"
    return ctx.fmt.planLabel(rawPlan) || null
  }

  function getResetsAtIso(ctx, nowSec, window) {
    if (!window) return null
    if (typeof window.reset_at === "number") {
      return ctx.util.toIso(window.reset_at)
    }
    if (typeof window.reset_after_seconds === "number") {
      return ctx.util.toIso(nowSec + window.reset_after_seconds)
    }
    return null
  }

  // Period durations in milliseconds
  var PERIOD_SESSION_MS = 5 * 60 * 60 * 1000    // 5 hours
  var PERIOD_WEEKLY_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

  function queryTokenUsage(ctx) {
    if (!ctx.host.ccusage || typeof ctx.host.ccusage.query !== "function") {
      return { status: "no_runner", data: null }
    }

    const since = new Date()
    // Inclusive range: today + previous 30 days = 31 calendar days.
    since.setDate(since.getDate() - 30)
    const y = since.getFullYear()
    const m = since.getMonth() + 1
    const d = since.getDate()
    const sinceStr = "" + y + (m < 10 ? "0" : "") + m + (d < 10 ? "0" : "") + d
    const queryOpts = { provider: "codex", since: sinceStr }

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
    return parts.join(" · ")
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

  function probe(ctx) {
    const authState = loadAuth(ctx)
    if (!authState || !authState.auth) {
      ctx.host.log.error("probe failed: not logged in")
      throw "Not logged in. Run `codex` to authenticate."
    }
    const auth = authState.auth

    if (auth.tokens && auth.tokens.access_token) {
      const nowMs = Date.now()
      let accessToken = auth.tokens.access_token
      let accountId = auth.tokens.account_id

      if (needsRefresh(ctx, auth, nowMs)) {
        ctx.host.log.info("token needs refresh (age > " + (REFRESH_AGE_MS / 1000 / 60 / 60 / 24) + " days)")
        const refreshed = refreshToken(ctx, authState)
        if (refreshed) {
          accessToken = refreshed
          accountId = auth.tokens.account_id
        } else {
          ctx.host.log.warn("proactive refresh failed, trying with existing token")
        }
      }

      let resp
      let didRefresh = false
      try {
        resp = ctx.util.retryOnceOnAuth({
          request: (token) => {
            try {
              return fetchUsage(ctx, token || accessToken, accountId)
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
            const refreshed = refreshToken(ctx, authState)
            accountId = auth.tokens.account_id
            return refreshed
          },
        })
      } catch (e) {
        if (typeof e === "string") throw e
        ctx.host.log.error("usage request failed: " + String(e))
        throw "Usage request failed. Check your connection."
      }

      if (ctx.util.isAuthStatus(resp.status)) {
        ctx.host.log.error("usage returned auth error after all retries: status=" + resp.status)
        throw "Token expired. Run `codex` to log in again."
      }

      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.error("usage returned error: status=" + resp.status)
        throw "Usage request failed (HTTP " + String(resp.status) + "). Try again later."
      }

      ctx.host.log.info("usage fetch succeeded")

      const data = ctx.util.tryParseJson(resp.bodyText)
      if (data === null) {
        throw "Usage response invalid. Try again later."
      }

      const lines = []
      const nowSec = Math.floor(Date.now() / 1000)
      const rateLimit = data.rate_limit || null
      const primaryWindow = rateLimit && rateLimit.primary_window ? rateLimit.primary_window : null
      const secondaryWindow = rateLimit && rateLimit.secondary_window ? rateLimit.secondary_window : null
      const reviewWindow =
        data.code_review_rate_limit && data.code_review_rate_limit.primary_window
          ? data.code_review_rate_limit.primary_window
          : null

      const headerPrimary = readPercent(resp.headers["x-codex-primary-used-percent"])
      const headerSecondary = readPercent(resp.headers["x-codex-secondary-used-percent"])

      if (headerPrimary !== null) {
        lines.push(ctx.line.progress({
          label: "Session",
          used: headerPrimary,
          limit: 100,
          format: { kind: "percent" },
          resetsAt: getResetsAtIso(ctx, nowSec, primaryWindow),
          periodDurationMs: PERIOD_SESSION_MS
        }))
      }
      if (headerSecondary !== null) {
        lines.push(ctx.line.progress({
          label: "Weekly",
          used: headerSecondary,
          limit: 100,
          format: { kind: "percent" },
          resetsAt: getResetsAtIso(ctx, nowSec, secondaryWindow),
          periodDurationMs: PERIOD_WEEKLY_MS
        }))
      }

      if (lines.length === 0 && data.rate_limit) {
        if (data.rate_limit.primary_window && typeof data.rate_limit.primary_window.used_percent === "number") {
          lines.push(ctx.line.progress({
            label: "Session",
            used: data.rate_limit.primary_window.used_percent,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: getResetsAtIso(ctx, nowSec, primaryWindow),
            periodDurationMs: PERIOD_SESSION_MS
          }))
        }
        if (data.rate_limit.secondary_window && typeof data.rate_limit.secondary_window.used_percent === "number") {
          lines.push(ctx.line.progress({
            label: "Weekly",
            used: data.rate_limit.secondary_window.used_percent,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: getResetsAtIso(ctx, nowSec, secondaryWindow),
            periodDurationMs: PERIOD_WEEKLY_MS
          }))
        }
      }

      if (Array.isArray(data.additional_rate_limits)) {
        for (const entry of data.additional_rate_limits) {
          if (!entry || !entry.rate_limit) continue
          const name = typeof entry.limit_name === "string" ? entry.limit_name : ""
          let shortName = name.replace(/^GPT-[\d.]+-Codex-/, "")
          if (!shortName) shortName = name || "Model"
          const rl = entry.rate_limit
          if (rl.primary_window && typeof rl.primary_window.used_percent === "number") {
            lines.push(ctx.line.progress({
              label: shortName,
              used: rl.primary_window.used_percent,
              limit: 100,
              format: { kind: "percent" },
              resetsAt: getResetsAtIso(ctx, nowSec, rl.primary_window),
              periodDurationMs: typeof rl.primary_window.limit_window_seconds === "number"
                ? rl.primary_window.limit_window_seconds * 1000
                : PERIOD_SESSION_MS
            }))
          }
          if (rl.secondary_window && typeof rl.secondary_window.used_percent === "number") {
            lines.push(ctx.line.progress({
              label: shortName + " Weekly",
              used: rl.secondary_window.used_percent,
              limit: 100,
              format: { kind: "percent" },
              resetsAt: getResetsAtIso(ctx, nowSec, rl.secondary_window),
              periodDurationMs: typeof rl.secondary_window.limit_window_seconds === "number"
                ? rl.secondary_window.limit_window_seconds * 1000
                : PERIOD_WEEKLY_MS
            }))
          }
        }
      }

      if (reviewWindow) {
        const used = reviewWindow.used_percent
        if (typeof used === "number") {
          lines.push(ctx.line.progress({
            label: "Reviews",
            used: used,
            limit: 100,
            format: { kind: "percent" },
            resetsAt: getResetsAtIso(ctx, nowSec, reviewWindow),
            periodDurationMs: PERIOD_WEEKLY_MS // code_review_rate_limit is a 7-day window
          }))
        }
      }

      const creditsBalance = resp.headers["x-codex-credits-balance"]
      const creditsHeader = readNumber(creditsBalance)
      const creditsData = data.credits ? readNumber(data.credits.balance) : null
      const creditsRemaining = creditsHeader ?? creditsData
      if (creditsRemaining !== null) {
        const remaining = creditsRemaining
        const limit = 1000
        const used = Math.max(0, Math.min(limit, limit - remaining))
        lines.push(ctx.line.progress({
          label: "Credits",
          used: used,
          limit: limit,
          format: { kind: "count", suffix: "credits" },
        }))
      }

      let plan = null
      if (data.plan_type) {
        const planLabel = formatCodexPlan(ctx, data.plan_type)
        if (planLabel) {
          plan = planLabel
        }
      }

      const tokenUsageResult = queryTokenUsage(ctx)
      if (tokenUsageResult.status === "ok") {
        const tokenUsage = tokenUsageResult.data
        const now = new Date()
        const todayKey = dayKeyFromDate(now)
        const yesterday = new Date(now.getTime())
        yesterday.setDate(yesterday.getDate() - 1)
        const yesterdayKey = dayKeyFromDate(yesterday)

        let todayEntry = null
        let yesterdayEntry = null
        for (let i = 0; i < tokenUsage.daily.length; i++) {
          const usageDayKey = dayKeyFromUsageDate(tokenUsage.daily[i].date)
          if (usageDayKey === todayKey) {
            todayEntry = tokenUsage.daily[i]
            continue
          }
          if (usageDayKey === yesterdayKey) {
            yesterdayEntry = tokenUsage.daily[i]
          }
        }

        pushDayUsageLine(lines, ctx, "Today", todayEntry)
        pushDayUsageLine(lines, ctx, "Yesterday", yesterdayEntry)

        let totalTokens = 0
        let totalCostNanos = 0
        let hasCost = false
        for (let i = 0; i < tokenUsage.daily.length; i++) {
          const day = tokenUsage.daily[i]
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

      if (lines.length === 0) {
        lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))
      }

      const result = { plan: plan, lines: lines }
      result.updatedCredentialsJson = JSON.stringify({
        type: "oauth",
        accessToken: auth.tokens.access_token || "",
        refreshToken: auth.tokens.refresh_token || "",
        idToken: auth.tokens.id_token || "",
        accountId: auth.tokens.account_id || null,
        expiresAt: auth.tokens.expires_at || null,
        lastRefresh: auth.last_refresh || new Date().toISOString(),
      })
      return result
    }

    if (auth.OPENAI_API_KEY) {
      throw "Usage not available for API key."
    }

    throw "Not logged in. Run `codex` to authenticate."
  }

  globalThis.__openusage_plugin = { id: "codex", probe }
})()
