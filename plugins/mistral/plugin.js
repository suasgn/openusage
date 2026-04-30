(function () {
  const BASE_URL = "https://admin.mistral.ai"
  const USAGE_PATH = "/api/billing/v2/usage"

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

  function readInteger(value) {
    const n = readNumber(value)
    return n === null ? 0 : Math.trunc(n)
  }

  function pickString(values) {
    for (let i = 0; i < values.length; i += 1) {
      const value = readString(values[i])
      if (value) return value
    }
    return null
  }

  function loadCredentials(ctx) {
    const credentials = ctx.credentials && typeof ctx.credentials === "object" ? ctx.credentials : null
    return {
      cookieHeader: pickString([
        credentials && credentials.cookieHeader,
        credentials && credentials.cookie_header,
        credentials && credentials.cookie,
        credentials && credentials.session,
      ]),
    }
  }

  function cookiePairs(cookieHeader) {
    const raw = readString(cookieHeader)
    if (!raw) return []
    const parts = raw.split(";")
    const pairs = []
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i].trim()
      const idx = part.indexOf("=")
      if (idx <= 0) continue
      const name = part.slice(0, idx).trim()
      const value = part.slice(idx + 1).trim()
      if (name && value) pairs.push({ name, value })
    }
    return pairs
  }

  function hasSessionCookie(pairs) {
    for (let i = 0; i < pairs.length; i += 1) {
      if (pairs[i].name.indexOf("ory_session_") === 0) return true
    }
    return false
  }

  function csrfToken(pairs) {
    for (let i = 0; i < pairs.length; i += 1) {
      if (pairs[i].name === "csrftoken") return pairs[i].value
    }
    return null
  }

  function usageUrl(nowIso) {
    const now = new Date(nowIso || Date.now())
    const month = Number.isFinite(now.getTime()) ? now.getUTCMonth() + 1 : new Date().getUTCMonth() + 1
    const year = Number.isFinite(now.getTime()) ? now.getUTCFullYear() : new Date().getUTCFullYear()
    return BASE_URL + USAGE_PATH + "?month=" + encodeURIComponent(String(month)) + "&year=" + encodeURIComponent(String(year))
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

  function requestUsage(ctx, cookieHeader, csrf) {
    const headers = {
      Accept: "*/*",
      Cookie: cookieHeader,
      Referer: BASE_URL + "/organization/usage",
      Origin: BASE_URL,
      "User-Agent": "openburn",
    }
    if (csrf) headers["X-CSRFTOKEN"] = csrf

    let resp
    try {
      resp = ctx.util.request({
        method: "GET",
        url: usageUrl(ctx.nowIso),
        headers,
        timeoutMs: 10000,
      })
    } catch (e) {
      ctx.host.log.warn("request failed: " + String(e))
      throw "Request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "Mistral session cookie is invalid or expired."
    }
    if (resp.status < 200 || resp.status >= 300) {
      const detail = errorDetail(ctx, resp.bodyText)
      if (detail) throw "Mistral API error: " + detail
      throw "Request failed (HTTP " + resp.status + "). Try again later."
    }

    const parsed = ctx.util.tryParseJson(resp.bodyText)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw "Mistral response invalid. Try again later."
    }
    return parsed
  }

  function priceIndex(prices) {
    const out = {}
    if (!Array.isArray(prices)) return out
    for (let i = 0; i < prices.length; i += 1) {
      const price = prices[i]
      if (!price || typeof price !== "object") continue
      const metric = readString(price.billing_metric || price.billingMetric)
      const group = readString(price.billing_group || price.billingGroup)
      const amount = readNumber(price.price)
      if (metric && group && amount !== null) out[metric + "::" + group] = amount
    }
    return out
  }

  function aggregateEntries(entries, prices) {
    let tokens = 0
    let cost = 0
    if (!Array.isArray(entries)) return { tokens, cost }
    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i]
      if (!entry || typeof entry !== "object") continue
      const value = readInteger(entry.value_paid ?? entry.valuePaid ?? entry.value)
      tokens += value
      const metric = readString(entry.billing_metric || entry.billingMetric)
      const group = readString(entry.billing_group || entry.billingGroup)
      const unitPrice = metric && group ? prices[metric + "::" + group] : null
      if (typeof unitPrice === "number") cost += value * unitPrice
    }
    return { tokens, cost }
  }

  function aggregateModel(modelData, prices) {
    const input = aggregateEntries(modelData && modelData.input, prices)
    const output = aggregateEntries(modelData && modelData.output, prices)
    const cached = aggregateEntries(modelData && modelData.cached, prices)
    return {
      inputTokens: input.tokens,
      outputTokens: output.tokens,
      cachedTokens: cached.tokens,
      cost: input.cost + output.cost + cached.cost,
    }
  }

  function aggregateModelMap(models, prices, includeTokens) {
    const result = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0, modelCount: 0 }
    if (!models || typeof models !== "object" || Array.isArray(models)) return result
    for (const key in models) {
      const model = aggregateModel(models[key], prices)
      result.modelCount += 1
      result.cost += model.cost
      if (includeTokens) {
        result.inputTokens += model.inputTokens
        result.outputTokens += model.outputTokens
        result.cachedTokens += model.cachedTokens
      }
    }
    return result
  }

  function addTotals(target, source) {
    target.inputTokens += source.inputTokens
    target.outputTokens += source.outputTokens
    target.cachedTokens += source.cachedTokens
    target.cost += source.cost
    target.modelCount += source.modelCount
  }

  function parseSummary(root) {
    const prices = priceIndex(root.prices)
    const total = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cost: 0, modelCount: 0 }

    addTotals(total, aggregateModelMap(root.completion && root.completion.models, prices, true))
    addTotals(total, aggregateModelMap(root.ocr && root.ocr.models, prices, false))
    addTotals(total, aggregateModelMap(root.connectors && root.connectors.models, prices, false))
    addTotals(total, aggregateModelMap(root.audio && root.audio.models, prices, false))

    const libraries = root.libraries_api || root.librariesApi
    if (libraries && typeof libraries === "object") {
      addTotals(total, aggregateModelMap(libraries.pages && libraries.pages.models, prices, false))
      addTotals(total, aggregateModelMap(libraries.tokens && libraries.tokens.models, prices, false))
    }

    const fineTuning = root.fine_tuning || root.fineTuning
    if (fineTuning && typeof fineTuning === "object") {
      addTotals(total, aggregateModelMap(fineTuning.training, prices, false))
      addTotals(total, aggregateModelMap(fineTuning.storage, prices, false))
    }

    return {
      cost: total.cost,
      currency: readString(root.currency) || "EUR",
      currencySymbol: readString(root.currency_symbol || root.currencySymbol),
      inputTokens: total.inputTokens,
      outputTokens: total.outputTokens,
      cachedTokens: total.cachedTokens,
      modelCount: total.modelCount,
      startDate: ctxIso(root.start_date || root.startDate),
      endDate: ctxIso(root.end_date || root.endDate),
    }
  }

  function ctxIso(value) {
    if (!value) return null
    const ms = Date.parse(value)
    if (!Number.isFinite(ms)) return null
    return new Date(ms).toISOString()
  }

  function formatInteger(value) {
    const n = Math.trunc(Number(value || 0))
    const sign = n < 0 ? "-" : ""
    let text = String(Math.abs(n))
    let out = ""
    while (text.length > 3) {
      out = "," + text.slice(-3) + out
      text = text.slice(0, -3)
    }
    return sign + text + out
  }

  function formatCost(summary) {
    const symbol = summary.currencySymbol || (summary.currency === "USD" ? "$" : summary.currency + " ")
    const prefix = /^[A-Z]{3}$/.test(symbol) ? symbol + " " : symbol
    if (summary.cost <= 0) return prefix + "0.0000"
    return prefix + summary.cost.toFixed(4)
  }

  function resetSubtitle(summary) {
    if (!summary.endDate) return "This month"
    return "This month, resets " + summary.endDate.slice(0, 10)
  }

  function probe(ctx) {
    const credentials = loadCredentials(ctx)
    if (!credentials.cookieHeader) {
      throw "Mistral session cookie missing. Add a Mistral account in Settings."
    }

    const pairs = cookiePairs(credentials.cookieHeader)
    if (!hasSessionCookie(pairs)) {
      throw "Mistral session cookie is missing ory_session_*. Re-authenticate in Settings."
    }

    const json = requestUsage(ctx, credentials.cookieHeader, csrfToken(pairs))
    const summary = parseSummary(json)
    const lines = [
      ctx.line.text({ label: "Cost", value: formatCost(summary), subtitle: resetSubtitle(summary) }),
      ctx.line.text({ label: "Input Tokens", value: formatInteger(summary.inputTokens) }),
      ctx.line.text({ label: "Output Tokens", value: formatInteger(summary.outputTokens) }),
    ]

    if (summary.cachedTokens > 0) {
      lines.push(ctx.line.text({ label: "Cached Tokens", value: formatInteger(summary.cachedTokens) }))
    }
    if (summary.modelCount > 0) {
      lines.push(ctx.line.text({ label: "Models", value: formatInteger(summary.modelCount) }))
    }
    if (summary.cost <= 0 && summary.inputTokens <= 0 && summary.outputTokens <= 0) {
      lines.push(ctx.line.badge({ label: "Status", text: "No usage", color: "#a3a3a3" }))
    }

    return { plan: null, lines }
  }

  globalThis.__openusage_plugin = { id: "mistral", probe }
})()
