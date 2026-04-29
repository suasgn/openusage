(function () {
  const BASE_URL = "https://opencode.ai"
  const SERVER_URL = "https://opencode.ai/_server"
  const WORKSPACES_SERVER_ID = "def39973159c7f0483d8793a822b8dbb10d067e12c65455fcb4608459ba0234f"
  const SUBSCRIPTION_SERVER_ID = "7abeebee372f304e050aaaf92be863f4a86490e382f8c79db68fd94040d691b4"
  const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36"
  const PERIOD_5_HOURS_MS = 5 * 60 * 60 * 1000
  const PERIOD_7_DAYS_MS = 7 * 24 * 60 * 60 * 1000
  const PERIOD_30_DAYS_MS = 30 * 24 * 60 * 60 * 1000

  const PERCENT_KEYS = ["usagePercent", "usage_percent", "usedPercent", "used_percent", "percent", "ratio"]
  const RESET_IN_KEYS = ["resetInSec", "reset_in_sec", "resetSeconds", "reset_seconds", "expiresInSec", "expires_in_sec"]
  const RESET_AT_KEYS = ["resetAt", "reset_at", "resetsAt", "resets_at", "nextReset", "next_reset", "renewAt", "renew_at"]
  const USED_KEYS = ["used", "usage", "consumed", "count", "usedTokens"]
  const LIMIT_KEYS = ["limit", "total", "quota", "max", "cap", "tokenLimit"]

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

  function clampPercent(value) {
    if (!Number.isFinite(value)) return 0
    return Math.max(0, Math.min(100, value))
  }

  function loadCredentials(ctx) {
    const credentials = ctx.credentials && typeof ctx.credentials === "object" ? ctx.credentials : null
    const settings = ctx.account && ctx.account.settings && typeof ctx.account.settings === "object" ? ctx.account.settings : null
    return {
      cookieHeader: pickString([
        credentials && credentials.cookieHeader,
        credentials && credentials.cookie_header,
        credentials && credentials.cookie,
        credentials && credentials.session,
      ]),
      workspaceId: normalizeWorkspaceId(pickString([
        credentials && credentials.workspaceId,
        credentials && credentials.workspace_id,
        credentials && credentials.workspace,
        settings && settings.workspaceId,
        settings && settings.workspace_id,
        settings && settings.workspace,
      ])),
    }
  }

  function normalizeWorkspaceId(raw) {
    const value = readString(raw)
    if (!value) return null
    if (value.indexOf("wrk_") === 0 && value.length > 4) return value
    const match = value.match(/wrk_[A-Za-z0-9]+/)
    return match ? match[0] : null
  }

  function bodyHint(text) {
    const trimmed = String(text || "").trim()
    if (!trimmed) return "empty"
    if (trimmed.charAt(0) === "<") return "html"
    if (trimmed.charAt(0) === "{" || trimmed.charAt(0) === "[") return "json"
    return "text"
  }

  function looksSignedOut(text) {
    const lower = String(text || "").toLowerCase()
    return lower.indexOf("login") !== -1 || lower.indexOf("sign in") !== -1 || lower.indexOf("auth/authorize") !== -1
  }

  function invalidCredentials() {
    throw "OpenCode session cookie is invalid or expired."
  }

  function extractHtmlTitle(text) {
    const match = String(text || "").match(/<title>([^<]+)<\/title>/i)
    return match && match[1] ? match[1].trim() : null
  }

  function extractServerErrorMessage(ctx, text) {
    const parsed = ctx.util.tryParseJson(text)
    if (parsed && typeof parsed === "object") {
      return readString(parsed.message) || readString(parsed.error) || readString(parsed.detail)
    }
    return extractHtmlTitle(text)
  }

  function extractServerFnErrorMessage(text) {
    const match = String(text || "").match(/new Error\("((?:\\.|[^"])*)"\)/)
    if (!match || !match[1]) return null
    return match[1]
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .trim() || null
  }

  function isExplicitNullPayload(ctx, text) {
    const trimmed = String(text || "").trim()
    if (trimmed.toLowerCase() === "null") return true
    return ctx.util.tryParseJson(trimmed) === null && trimmed === "null"
  }

  function isServerFnNullPayload(text) {
    return /\]=\[\],\s*null\)/.test(String(text || ""))
  }

  function serverInstanceId() {
    return "server-fn:" + String(Date.now()) + String(Math.random()).slice(2)
  }

  function serverRequestUrl(request) {
    if (String(request.method || "GET").toUpperCase() !== "GET") return SERVER_URL
    let url = SERVER_URL + "?id=" + encodeURIComponent(request.serverId)
    if (request.args !== undefined && request.args !== null) {
      const isEmptyArray = Array.isArray(request.args) && request.args.length === 0
      if (!isEmptyArray) url += "&args=" + encodeURIComponent(JSON.stringify(request.args))
    }
    return url
  }

  function requestText(ctx, opts, failurePrefix) {
    let resp
    try {
      resp = ctx.util.request(opts)
    } catch (e) {
      ctx.host.log.warn(failurePrefix + " network error: " + String(e))
      throw "OpenCode network error: " + String(e)
    }

    const body = String(resp.bodyText || "")
    if (ctx.util.isAuthStatus(resp.status)) invalidCredentials()
    if (resp.status < 200 || resp.status >= 300) {
      if (looksSignedOut(body)) invalidCredentials()
      const message = extractServerErrorMessage(ctx, body)
      if (message) throw failurePrefix + " API error: HTTP " + resp.status + " - " + message
      throw failurePrefix + " API error (HTTP " + resp.status + "). Try again later."
    }
    if (looksSignedOut(body)) invalidCredentials()
    return body
  }

  function fetchServerText(ctx, request, cookieHeader) {
    const method = String(request.method || "GET").toUpperCase()
    const headers = {
      Cookie: cookieHeader,
      "X-Server-Id": request.serverId,
      "X-Server-Instance": serverInstanceId(),
      "User-Agent": USER_AGENT,
      Origin: BASE_URL,
      Referer: request.referer,
      Accept: "text/javascript, application/json;q=0.9, */*;q=0.8",
    }
    const opts = {
      method,
      url: serverRequestUrl(request),
      headers,
      timeoutMs: 10000,
    }
    if (method !== "GET" && request.args !== undefined && request.args !== null) {
      opts.headers["Content-Type"] = "application/json"
      opts.bodyText = JSON.stringify(request.args)
    }
    return requestText(ctx, opts, "OpenCode")
  }

  function fetchPageText(ctx, url, cookieHeader) {
    return requestText(ctx, {
      method: "GET",
      url,
      headers: {
        Cookie: cookieHeader,
        "User-Agent": USER_AGENT,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      timeoutMs: 10000,
    }, "OpenCode Go")
  }

  function collectWorkspaceIds(value, out) {
    if (!value) return
    if (typeof value === "string") {
      const workspaceId = normalizeWorkspaceId(value)
      if (workspaceId && out.indexOf(workspaceId) === -1) out.push(workspaceId)
      return
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) collectWorkspaceIds(value[i], out)
      return
    }
    if (typeof value === "object") {
      const keys = Object.keys(value)
      for (let i = 0; i < keys.length; i += 1) collectWorkspaceIds(value[keys[i]], out)
    }
  }

  function parseWorkspaceIds(ctx, text) {
    const out = []
    let match
    const regex = /id"?\s*:\s*"(wrk_[^"]+)"/g
    while ((match = regex.exec(text))) {
      if (out.indexOf(match[1]) === -1) out.push(match[1])
    }
    const parsed = ctx.util.tryParseJson(text)
    if (parsed) collectWorkspaceIds(parsed, out)
    return out
  }

  function fetchWorkspaceId(ctx, cookieHeader) {
    const request = {
      serverId: WORKSPACES_SERVER_ID,
      method: "GET",
      referer: BASE_URL,
    }
    let response = fetchServerText(ctx, request, cookieHeader)
    let ids = parseWorkspaceIds(ctx, response)
    if (ids.length) return ids[0]

    response = fetchServerText(ctx, {
      serverId: WORKSPACES_SERVER_ID,
      method: "POST",
      referer: BASE_URL,
      args: [],
    }, cookieHeader)
    ids = parseWorkspaceIds(ctx, response)
    if (ids.length) return ids[0]

    ctx.host.log.error("workspace ids missing after GET/POST, body hint: " + bodyHint(response))
    throw "OpenCode parse error: Missing workspace id."
  }

  function valueNumber(value) {
    return readNumber(value)
  }

  function numberFromMap(map, keys) {
    for (let i = 0; i < keys.length; i += 1) {
      const value = valueNumber(map[keys[i]])
      if (value !== null) return value
    }
    return null
  }

  function resetInSecondsFromValue(value, nowSec) {
    if (value === null || value === undefined) return null
    const n = readNumber(value)
    if (n !== null) {
      if (n > 1000000000000) return Math.max(0, Math.floor(n / 1000) - nowSec)
      if (n > 1000000000) return Math.max(0, Math.floor(n) - nowSec)
      return null
    }
    const parsed = Date.parse(String(value).trim())
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed / 1000) - nowSec)
    return null
  }

  function resetInSecondsFromMap(map, keys, nowSec) {
    for (let i = 0; i < keys.length; i += 1) {
      const seconds = resetInSecondsFromValue(map[keys[i]], nowSec)
      if (seconds !== null) return seconds
    }
    return null
  }

  function parseWindow(map, nowSec) {
    if (!map || typeof map !== "object" || Array.isArray(map)) return null
    let percent = numberFromMap(map, PERCENT_KEYS)
    if (percent === null) {
      const used = numberFromMap(map, USED_KEYS)
      const limit = numberFromMap(map, LIMIT_KEYS)
      if (used !== null && limit !== null && limit > 0) percent = used / limit * 100
    }
    if (percent === null) return null
    if (percent >= 0 && percent <= 1) percent *= 100

    const resetInSec = Math.max(0, numberFromMap(map, RESET_IN_KEYS) || resetInSecondsFromMap(map, RESET_AT_KEYS, nowSec) || 0)
    return { percent: clampPercent(percent), resetInSec }
  }

  function firstObject(map, keys) {
    for (let i = 0; i < keys.length; i += 1) {
      const value = map[keys[i]]
      if (value && typeof value === "object" && !Array.isArray(value)) return value
    }
    return null
  }

  function parseUsageMap(map, includeMonthly, nowSec) {
    if (map.usage && typeof map.usage === "object" && !Array.isArray(map.usage)) {
      const nested = parseUsageMap(map.usage, includeMonthly, nowSec)
      if (nested) return nested
    }
    const rolling = firstObject(map, ["rollingUsage", "rolling", "rolling_usage", "rollingWindow", "rolling_window"])
    const weekly = firstObject(map, ["weeklyUsage", "weekly", "weekly_usage", "weeklyWindow", "weekly_window"])
    const monthly = includeMonthly ? firstObject(map, ["monthlyUsage", "monthly", "monthly_usage", "monthlyWindow", "monthly_window"]) : null
    if (!rolling || !weekly) return null
    const rollingWindow = parseWindow(rolling, nowSec)
    const weeklyWindow = parseWindow(weekly, nowSec)
    if (!rollingWindow || !weeklyWindow) return null
    return {
      rolling: rollingWindow,
      weekly: weeklyWindow,
      monthly: monthly ? parseWindow(monthly, nowSec) : null,
    }
  }

  function parseUsageNestedMap(map, includeMonthly, nowSec, depth) {
    if (depth > 3) return null
    let rolling = null
    let weekly = null
    let monthly = null
    const keys = Object.keys(map)
    for (let i = 0; i < keys.length; i += 1) {
      const value = map[keys[i]]
      if (!value || typeof value !== "object" || Array.isArray(value)) continue
      const lower = keys[i].toLowerCase()
      if (lower.indexOf("rolling") !== -1 || lower.indexOf("hour") !== -1 || lower.indexOf("5h") !== -1) rolling = value
      else if (lower.indexOf("weekly") !== -1 || lower.indexOf("week") !== -1) weekly = value
      else if (includeMonthly && (lower.indexOf("monthly") !== -1 || lower.indexOf("month") !== -1)) monthly = value
    }
    if (rolling && weekly) {
      const rollingWindow = parseWindow(rolling, nowSec)
      const weeklyWindow = parseWindow(weekly, nowSec)
      if (rollingWindow && weeklyWindow) {
        return { rolling: rollingWindow, weekly: weeklyWindow, monthly: monthly ? parseWindow(monthly, nowSec) : null }
      }
    }
    for (let i = 0; i < keys.length; i += 1) {
      const value = map[keys[i]]
      if (value && typeof value === "object") {
        const parsed = parseUsageValue(value, includeMonthly, nowSec, depth + 1)
        if (parsed) return parsed
      }
    }
    return null
  }

  function parseUsageValue(value, includeMonthly, nowSec, depth) {
    if (!value || depth > 5) return null
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) {
        const parsed = parseUsageValue(value[i], includeMonthly, nowSec, depth + 1)
        if (parsed) return parsed
      }
      return null
    }
    if (typeof value !== "object") return null
    const direct = parseUsageMap(value, includeMonthly, nowSec)
    if (direct) return direct
    const keys = ["data", "result", "usage", "billing", "payload"]
    for (let i = 0; i < keys.length; i += 1) {
      if (value[keys[i]]) {
        const parsed = parseUsageValue(value[keys[i]], includeMonthly, nowSec, depth + 1)
        if (parsed) return parsed
      }
    }
    return parseUsageNestedMap(value, includeMonthly, nowSec, depth)
  }

  function parseUsageWindowsFromJson(ctx, text, includeMonthly, nowSec) {
    const parsed = ctx.util.tryParseJson(text)
    return parsed ? parseUsageValue(parsed, includeMonthly, nowSec, 0) : null
  }

  function extractRegexNumber(text, regex) {
    const match = String(text || "").match(regex)
    return match && match[1] ? readNumber(match[1]) : null
  }

  function parseUsageWindowsFromRegex(text, includeMonthly) {
    const rollingPercent = extractRegexNumber(text, /rollingUsage[^}]*?usagePercent"?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/)
    const rollingReset = extractRegexNumber(text, /rollingUsage[^}]*?resetInSec"?\s*[:=]\s*([0-9]+)/)
    const weeklyPercent = extractRegexNumber(text, /weeklyUsage[^}]*?usagePercent"?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/)
    const weeklyReset = extractRegexNumber(text, /weeklyUsage[^}]*?resetInSec"?\s*[:=]\s*([0-9]+)/)
    if (rollingPercent === null || rollingReset === null || weeklyPercent === null || weeklyReset === null) return null
    const monthlyPercent = includeMonthly ? extractRegexNumber(text, /monthlyUsage[^}]*?usagePercent"?\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/) : null
    const monthlyReset = includeMonthly ? extractRegexNumber(text, /monthlyUsage[^}]*?resetInSec"?\s*[:=]\s*([0-9]+)/) : null
    return {
      rolling: { percent: clampPercent(rollingPercent), resetInSec: Math.max(0, rollingReset) },
      weekly: { percent: clampPercent(weeklyPercent), resetInSec: Math.max(0, weeklyReset) },
      monthly: monthlyPercent !== null && monthlyReset !== null ? { percent: clampPercent(monthlyPercent), resetInSec: Math.max(0, monthlyReset) } : null,
    }
  }

  function parseUsageWindows(ctx, text, includeMonthly, nowSec) {
    return parseUsageWindowsFromJson(ctx, text, includeMonthly, nowSec) || parseUsageWindowsFromRegex(text, includeMonthly)
  }

  function missingSubscriptionDataError(workspaceId) {
    return "OpenCode API error: No subscription usage data was returned for workspace " + workspaceId + ". This usually means this workspace does not have OpenCode subscription quota data available."
  }

  function parseSubscriptionUsageText(ctx, text, workspaceId) {
    const serverError = extractServerFnErrorMessage(text)
    if (serverError) throw "OpenCode API error: " + serverError
    if (isExplicitNullPayload(ctx, text) || isServerFnNullPayload(text)) throw missingSubscriptionDataError(workspaceId)

    const nowSec = Math.floor(Date.now() / 1000)
    const windows = parseUsageWindows(ctx, text, false, nowSec)
    if (!windows) throw "OpenCode parse error: Missing usage fields in subscription payload."
    const planMatch = String(text || "").match(/(?:planType|subscriptionType|planName|plan_type|plan_name)"?\s*[:=]\s*["']([^"']+)["']/)
    const costs = []
    const costRegex = /totalCost"?\s*[:=]\s*(-?[0-9]+(?:\.[0-9]+)?)/g
    let match
    while ((match = costRegex.exec(text))) costs.push(Number(match[1]))
    const hasUsageArray = /(?:usage\s*:\s*\$R\[\d+\]\s*=\s*\[|"usage"\s*:\s*\[)/.test(String(text || ""))
    const usageRows = (String(text || "").match(/(?:\{\s*date\s*:|"date"\s*:)/g) || []).length
    const subscriptionRows = (String(text || "").match(/subscription"?\s*:\s*(?:!0|true)/g) || []).length
    return {
      rolling: windows.rolling,
      weekly: windows.weekly,
      plan: planMatch && planMatch[1] ? planMatch[1].trim() : null,
      monthlyTotalCostUsd: costs.length ? costs.reduce((sum, value) => sum + value, 0) : hasUsageArray ? 0 : null,
      usageRows,
      subscriptionRows,
    }
  }

  function parseGoUsageText(ctx, text, workspaceId) {
    const serverError = extractServerFnErrorMessage(text)
    if (serverError) throw "OpenCode Go API error: " + serverError
    if (isExplicitNullPayload(ctx, text) || isServerFnNullPayload(text)) throw "OpenCode Go usage payload is empty for workspace " + workspaceId

    const nowSec = Math.floor(Date.now() / 1000)
    const windows = parseUsageWindows(ctx, text, true, nowSec)
    if (!windows) throw "OpenCode Go parse error: Missing usage fields."
    return { rolling: windows.rolling, weekly: windows.weekly, monthly: windows.monthly }
  }

  function fetchSubscriptionUsage(ctx, workspaceId, cookieHeader) {
    const referer = BASE_URL + "/workspace/" + workspaceId + "/billing"
    const args = [workspaceId]
    let response = fetchServerText(ctx, {
      serverId: SUBSCRIPTION_SERVER_ID,
      args,
      method: "GET",
      referer,
    }, cookieHeader)
    try {
      return parseSubscriptionUsageText(ctx, response, workspaceId)
    } catch (e) {
      if (String(e).indexOf("Missing usage fields in subscription payload") === -1) throw e
      response = fetchServerText(ctx, {
        serverId: SUBSCRIPTION_SERVER_ID,
        args,
        method: "POST",
        referer,
      }, cookieHeader)
      return parseSubscriptionUsageText(ctx, response, workspaceId)
    }
  }

  function fetchGoUsage(ctx, workspaceId, cookieHeader) {
    const response = fetchPageText(ctx, BASE_URL + "/workspace/" + workspaceId + "/go", cookieHeader)
    return parseGoUsageText(ctx, response, workspaceId)
  }

  function selectUsageError(errors) {
    for (let i = 0; i < errors.length; i += 1) {
      if (String(errors[i]).indexOf("invalid or expired") !== -1) return errors[i]
    }
    return errors.length ? errors[0] : "OpenCode usage data is unavailable."
  }

  function fetchUsage(ctx, cookieHeader, workspaceId) {
    const resolvedWorkspaceId = workspaceId || fetchWorkspaceId(ctx, cookieHeader)
    const errors = []
    let subscription = null
    let go = null
    try {
      subscription = fetchSubscriptionUsage(ctx, resolvedWorkspaceId, cookieHeader)
    } catch (e) {
      ctx.host.log.warn("subscription fetch failed: " + String(e))
      errors.push(e)
    }
    try {
      go = fetchGoUsage(ctx, resolvedWorkspaceId, cookieHeader)
    } catch (e) {
      ctx.host.log.warn("go fetch failed: " + String(e))
      errors.push(e)
    }
    if (!subscription && !go) throw selectUsageError(errors)
    return { subscription, go }
  }

  function resetIso(nowSec, resetInSec) {
    return new Date((nowSec + Math.max(0, resetInSec || 0)) * 1000).toISOString()
  }

  function addPercentLine(ctx, lines, label, window, nowSec, periodDurationMs) {
    lines.push(ctx.line.progress({
      label,
      used: clampPercent(window.percent),
      limit: 100,
      format: { kind: "percent" },
      resetsAt: resetIso(nowSec, window.resetInSec),
      periodDurationMs,
    }))
  }

  function probe(ctx) {
    const credentials = loadCredentials(ctx)
    if (!credentials.cookieHeader) {
      throw "OpenCode session cookie is invalid or expired."
    }

    const snapshot = fetchUsage(ctx, credentials.cookieHeader, credentials.workspaceId)
    const nowSec = Math.floor(Date.now() / 1000)
    const lines = []

    if (snapshot.subscription) {
      addPercentLine(ctx, lines, "Session", snapshot.subscription.rolling, nowSec, PERIOD_5_HOURS_MS)
      addPercentLine(ctx, lines, "Weekly", snapshot.subscription.weekly, nowSec, PERIOD_7_DAYS_MS)
      if (snapshot.subscription.monthlyTotalCostUsd !== null && snapshot.subscription.monthlyTotalCostUsd !== undefined) {
        lines.push(ctx.line.text({ label: "Monthly Cost", value: "$" + Math.max(0, snapshot.subscription.monthlyTotalCostUsd).toFixed(2) }))
      }
      if (snapshot.subscription.subscriptionRows > 0 && snapshot.subscription.subscriptionRows !== snapshot.subscription.usageRows) {
        lines.push(ctx.line.badge({ label: "Subscription Rows", text: String(snapshot.subscription.subscriptionRows) }))
      }
    }

    if (snapshot.go) {
      addPercentLine(ctx, lines, "Go Session", snapshot.go.rolling, nowSec, PERIOD_5_HOURS_MS)
      addPercentLine(ctx, lines, "Go Weekly", snapshot.go.weekly, nowSec, PERIOD_7_DAYS_MS)
      if (snapshot.go.monthly) addPercentLine(ctx, lines, "Go Monthly", snapshot.go.monthly, nowSec, PERIOD_30_DAYS_MS)
    }

    if (lines.length === 0) {
      lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))
    }

    const plan = snapshot.subscription && snapshot.subscription.plan ? ctx.fmt.planLabel(snapshot.subscription.plan) : null
    return { plan, lines }
  }

  globalThis.__openusage_plugin = { id: "opencode", probe }
})()
