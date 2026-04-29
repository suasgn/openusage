(function () {
  const DEFAULT_BASE_URL = "https://app.kilo.ai/api/trpc"
  const PROCEDURES = ["user.getCreditBlocks", "kiloPass.getState"]
  const DOLLAR_FORMAT = { kind: "dollars" }
  const PERCENT_FORMAT = { kind: "percent" }

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

  function withScheme(raw) {
    const value = readString(raw)
    if (!value) return null
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
    return "https://" + value
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
      apiHost: pickString([credentials && credentials.apiHost, credentials && credentials.api_host, credentials && credentials.api_url]),
    }
  }

  function buildBatchUrl(baseUrl) {
    const base = (withScheme(baseUrl) || DEFAULT_BASE_URL).replace(/\/+$/, "")
    const input = { "0": null, "1": null }
    return base + "/" + PROCEDURES.join(",") + "?batch=1&input=" + encodeURIComponent(JSON.stringify(input))
  }

  function extractErrorMessage(entry) {
    const error = entry && entry.error
    if (!error || typeof error !== "object") return null
    return readString(error.message)
  }

  function isAuthError(entry) {
    const error = entry && entry.error
    if (!error || typeof error !== "object") return false
    const code = readString(error.data && error.data.code) || readString(error.code) || ""
    const message = (readString(error.message) || "").toLowerCase()
    return code.indexOf("UNAUTHORIZED") !== -1 || code.indexOf("FORBIDDEN") !== -1 || message.indexOf("unauthorized") !== -1 || message.indexOf("forbidden") !== -1 || message.indexOf("not authenticated") !== -1
  }

  function errorDetail(ctx, bodyText) {
    const parsed = ctx.util.tryParseJson(bodyText)
    if (!parsed) return null
    const entries = normalizeEntries(parsed)
    for (let i = 0; i < entries.length; i += 1) {
      const message = extractErrorMessage(entries[i])
      if (message) return message
    }
    if (typeof parsed === "object") {
      return readString(parsed.message) || readString(parsed.error) || readString(parsed.error && parsed.error.message)
    }
    return null
  }

  function requestJson(ctx, credentials) {
    let resp
    try {
      resp = ctx.util.request({
        method: "GET",
        url: buildBatchUrl(credentials.apiHost || DEFAULT_BASE_URL),
        headers: {
          Authorization: authHeader(credentials.apiKey),
          Accept: "application/json",
          "User-Agent": "OpenUsage",
        },
        timeoutMs: 10000,
      })
    } catch (e) {
      ctx.host.log.warn("request failed: " + String(e))
      throw "Request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "Kilo authentication failed. Check your API key."
    }
    if (resp.status === 404) {
      throw "Kilo API endpoint not found (404)."
    }
    if (resp.status >= 500 && resp.status < 600) {
      throw "Kilo API unavailable (HTTP " + resp.status + "). Try again later."
    }
    if (resp.status < 200 || resp.status >= 300) {
      const detail = errorDetail(ctx, resp.bodyText)
      if (detail) throw "Kilo request failed: " + detail
      throw "Kilo request failed (HTTP " + resp.status + "). Try again later."
    }

    const parsed = ctx.util.tryParseJson(resp.bodyText)
    if (!parsed || typeof parsed !== "object") {
      throw "Kilo response invalid. Try again later."
    }
    return parsed
  }

  function normalizeEntries(root) {
    if (Array.isArray(root)) return root
    if (!root || typeof root !== "object") return []
    if (root.result || root.error) return [root]

    const keys = Object.keys(root)
      .filter((key) => /^\d+$/.test(key))
      .sort((a, b) => Number(a) - Number(b))
    const entries = []
    for (let i = 0; i < keys.length; i += 1) entries.push(root[keys[i]])
    return entries
  }

  function payloadFromEntry(entry) {
    if (!entry || typeof entry !== "object") return null
    const result = entry.result && typeof entry.result === "object" ? entry.result : null
    if (!result) return null
    const data = result.data
    if (data && typeof data === "object") {
      if (data.json !== undefined && data.json !== null) return data.json
      return data
    }
    if (result.json !== undefined && result.json !== null) return result.json
    return result
  }

  function parseResponse(root) {
    const entries = normalizeEntries(root)
    if (!entries.length) throw "Unexpected Kilo response format."

    const payloads = [null, null]
    for (let i = 0; i < entries.length && i < 2; i += 1) {
      if (isAuthError(entries[i])) throw "Kilo authentication failed."
      payloads[i] = payloadFromEntry(entries[i])
    }

    const credits = parseCreditFields(payloads[0])
    const pass = parsePassFields(payloads[1])
    return { credits, pass }
  }

  function collectContexts(value) {
    const result = []
    if (!value || typeof value !== "object" || Array.isArray(value)) return result
    result.push(value)
    const keys = Object.keys(value)
    for (let i = 0; i < keys.length; i += 1) {
      const child = value[keys[i]]
      if (child && typeof child === "object" && !Array.isArray(child)) result.push(child)
    }
    return result
  }

  function findArray(contexts, keys) {
    for (let i = 0; i < contexts.length; i += 1) {
      for (let j = 0; j < keys.length; j += 1) {
        const value = contexts[i][keys[j]]
        if (Array.isArray(value)) return value
      }
    }
    return null
  }

  function findNumber(contexts, keys) {
    for (let i = 0; i < contexts.length; i += 1) {
      for (let j = 0; j < keys.length; j += 1) {
        const value = readNumber(contexts[i][keys[j]])
        if (value !== null) return value
      }
    }
    return null
  }

  function findString(contexts, keys) {
    for (let i = 0; i < contexts.length; i += 1) {
      for (let j = 0; j < keys.length; j += 1) {
        const value = readString(contexts[i][keys[j]])
        if (value) return value
      }
    }
    return null
  }

  function parseCreditFields(payload) {
    const contexts = collectContexts(payload)
    const blocks = findArray(contexts, ["creditBlocks"])
    if (blocks) {
      let total = 0
      let remaining = 0
      let hasTotal = false
      let hasRemaining = false
      for (let i = 0; i < blocks.length; i += 1) {
        const block = blocks[i]
        if (!block || typeof block !== "object") continue
        const amount = readNumber(block.amount_mUsd)
        const balance = readNumber(block.balance_mUsd)
        if (amount !== null) {
          total += amount / 1000000
          hasTotal = true
        }
        if (balance !== null) {
          remaining += balance / 1000000
          hasRemaining = true
        }
      }
      if (hasTotal || hasRemaining) {
        const normalizedTotal = hasTotal ? Math.max(0, total) : null
        const normalizedRemaining = hasRemaining ? Math.max(0, remaining) : null
        return {
          used: normalizedTotal !== null && normalizedRemaining !== null ? Math.max(0, normalizedTotal - normalizedRemaining) : null,
          total: normalizedTotal,
          remaining: normalizedRemaining,
        }
      }
    }

    return {
      used: findNumber(contexts, ["used", "usedCredits", "consumed", "spent", "creditsUsed"]),
      total: findNumber(contexts, ["total", "totalCredits", "creditsTotal", "limit"]),
      remaining: findNumber(contexts, ["remaining", "remainingCredits", "creditsRemaining"]),
    }
  }

  function parsePassFields(payload) {
    if (!payload || typeof payload !== "object") return { used: null, total: null, bonus: null, resetsAt: null, planName: null }

    const subscription = payload.subscription && typeof payload.subscription === "object" ? payload.subscription : payload
    if (subscription.currentPeriodUsageUsd !== undefined || subscription.currentPeriodBaseCreditsUsd !== undefined || subscription.tier !== undefined) {
      const used = readNumber(subscription.currentPeriodUsageUsd)
      const base = readNumber(subscription.currentPeriodBaseCreditsUsd)
      const bonus = Math.max(0, readNumber(subscription.currentPeriodBonusCreditsUsd) || 0)
      const tier = readString(subscription.tier)
      const names = { tier_19: "Starter", tier_49: "Pro", tier_199: "Expert" }
      return {
        used: used !== null ? Math.max(0, used) : null,
        total: base !== null ? Math.max(0, base) + bonus : null,
        bonus: bonus > 0 ? bonus : null,
        resetsAt: pickString([subscription.nextBillingAt, subscription.nextRenewalAt, subscription.renewsAt, subscription.renewAt]),
        planName: tier ? names[tier] || tier : "Kilo Pass",
      }
    }

    const contexts = collectContexts(payload)
    return {
      used: findNumber(contexts, ["used", "spent", "consumed", "creditsUsed"]),
      total: findNumber(contexts, ["total", "totalCredits", "limit", "planAmount", "included"]),
      bonus: findNumber(contexts, ["bonus", "bonusCredits", "bonusAmount", "includedBonus"]),
      resetsAt: findString(contexts, ["resetAt", "resetsAt", "renewAt", "renewsAt", "nextRenewalAt", "currentPeriodEnd"]),
      planName: findString(contexts, ["planName", "tier", "tierName", "passName"]),
    }
  }

  function addCreditLines(ctx, lines, credits) {
    if (credits.used !== null && credits.total !== null && credits.total > 0) {
      lines.push(ctx.line.progress({
        label: "Credits",
        used: clampPercent((credits.used / credits.total) * 100),
        limit: 100,
        format: PERCENT_FORMAT,
      }))
      lines.push(ctx.line.text({
        label: "Credit Balance",
        value: String(Math.round(credits.used)) + "/" + String(Math.round(credits.total)),
      }))
      return
    }

    if (credits.remaining !== null && credits.remaining > 0) {
      lines.push(ctx.line.badge({ label: "Credits", text: String(Math.round(credits.remaining)) + " remaining", color: "#22c55e" }))
    }
  }

  function addPassLines(ctx, lines, pass) {
    if (pass.used === null || pass.total === null || pass.total <= 0) return
    const opts = {
      label: "Kilo Pass",
      used: pass.used,
      limit: pass.total,
      format: DOLLAR_FORMAT,
    }
    const resetsAt = pass.resetsAt ? ctx.util.toIso(pass.resetsAt) : null
    if (resetsAt) opts.resetsAt = resetsAt
    lines.push(ctx.line.progress(opts))

    if (pass.bonus !== null && pass.bonus > 0) {
      const base = Math.max(0, pass.total - pass.bonus)
      lines.push(ctx.line.text({
        label: "Pass Details",
        value: "$" + pass.used.toFixed(2) + " / $" + base.toFixed(2) + " (+$" + pass.bonus.toFixed(2) + " bonus)",
      }))
    }
  }

  function probe(ctx) {
    const credentials = loadCredentials(ctx)
    if (!credentials.apiKey) {
      throw "Kilo API key missing. Add a Kilo account in Settings."
    }

    const snapshot = parseResponse(requestJson(ctx, credentials))
    const lines = []
    addCreditLines(ctx, lines, snapshot.credits)
    addPassLines(ctx, lines, snapshot.pass)

    if (lines.length === 0) {
      lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))
    }

    const plan = snapshot.pass.planName ? ctx.fmt.planLabel(snapshot.pass.planName) : null
    return { plan, lines }
  }

  globalThis.__openusage_plugin = { id: "kilo", probe }
})()
