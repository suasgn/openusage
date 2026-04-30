(function () {
  const BALANCE_URL = "https://api.deepseek.com/user/balance"

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
      readString(parsed.msg) ||
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
      throw "DeepSeek API key is invalid or expired."
    }

    if (resp.status < 200 || resp.status >= 300) {
      const detail = errorDetail(ctx, resp.bodyText)
      if (detail) throw "DeepSeek API error: " + detail
      throw "Request failed (HTTP " + resp.status + "). Try again later."
    }

    const parsed = ctx.util.tryParseJson(resp.bodyText)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw "DeepSeek response invalid. Try again later."
    }
    return parsed
  }

  function currencySymbol(currency) {
    const code = String(currency || "USD").toUpperCase()
    if (code === "USD") return "$"
    return code + " "
  }

  function formatMoney(value, currency) {
    const symbol = currencySymbol(currency)
    return symbol + Number(value || 0).toFixed(2)
  }

  function pickBalanceInfo(value) {
    const infos = Array.isArray(value) ? value : []
    if (!infos.length) return null
    for (let i = 0; i < infos.length; i += 1) {
      if (String(infos[i] && infos[i].currency).toUpperCase() === "USD") return infos[i]
    }
    return infos[0]
  }

  function parseBalanceInfo(info) {
    const currency = readString(info && info.currency) || "USD"
    const total = readNumber((info && (info.total_balance ?? info.totalBalance)) ?? null)
    const granted = readNumber((info && (info.granted_balance ?? info.grantedBalance)) ?? null)
    const paid = readNumber((info && (info.topped_up_balance ?? info.toppedUpBalance)) ?? null)

    if (total === null || granted === null || paid === null) {
      throw "DeepSeek balance response invalid. Try again later."
    }

    return { currency, total, granted, paid }
  }

  function balanceInfosFrom(json) {
    if (Array.isArray(json.balance_infos)) return json.balance_infos
    if (Array.isArray(json.balanceInfos)) return json.balanceInfos
    if (json.data && Array.isArray(json.data.balance_infos)) return json.data.balance_infos
    if (json.data && Array.isArray(json.data.balanceInfos)) return json.data.balanceInfos
    return []
  }

  function isAvailable(json) {
    if (json.is_available === false || json.isAvailable === false) return false
    if (json.data && (json.data.is_available === false || json.data.isAvailable === false)) return false
    return true
  }

  function probe(ctx) {
    const credentials = loadCredentials(ctx)
    if (!credentials.apiKey) {
      throw "DeepSeek API key missing. Add a DeepSeek account in Settings."
    }

    const parsed = requestJson(ctx, {
      method: "GET",
      url: BALANCE_URL,
      headers: {
        Authorization: authHeader(credentials.apiKey),
        Accept: "application/json",
        "User-Agent": "openburn",
      },
      timeoutMs: 10000,
    })

    const balanceInfo = pickBalanceInfo(balanceInfosFrom(parsed))
    if (!balanceInfo) {
      return {
        plan: null,
        lines: [ctx.line.badge({ label: "Status", text: "No balance data", color: "#a3a3a3" })],
      }
    }

    const balance = parseBalanceInfo(balanceInfo)
    const lines = [
      ctx.line.text({
        label: "Balance",
        value: formatMoney(balance.total, balance.currency),
        subtitle: "Paid " + formatMoney(balance.paid, balance.currency) + " / Granted " + formatMoney(balance.granted, balance.currency),
      }),
      ctx.line.text({ label: "Paid", value: formatMoney(balance.paid, balance.currency) }),
      ctx.line.text({ label: "Granted", value: formatMoney(balance.granted, balance.currency) }),
    ]

    if (!isAvailable(parsed)) {
      lines.push(ctx.line.badge({ label: "Status", text: "Unavailable", color: "#ef4444" }))
    } else if (balance.total <= 0) {
      lines.push(ctx.line.badge({ label: "Status", text: "No credits", color: "#f59e0b" }))
    }

    return { plan: null, lines }
  }

  globalThis.__openusage_plugin = { id: "deepseek", probe }
})()
