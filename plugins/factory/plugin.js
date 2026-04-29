(function () {
  const WORKOS_CLIENT_ID = "client_01HNM792M5G5G1A2THWPXKFMXB"
  const WORKOS_AUTH_URL = "https://api.workos.com/user_management/authenticate"
  const USAGE_URL = "https://api.factory.ai/api/organization/subscription/usage"
  const TOKEN_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000 // 24 hours before expiry

  function decodeHexUtf8(hex) {
    try {
      const bytes = []
      for (let i = 0; i < hex.length; i += 2) {
        bytes.push(parseInt(hex.slice(i, i + 2), 16))
      }

      if (typeof TextDecoder !== "undefined") {
        try {
          return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes))
        } catch {}
      }

      let escaped = ""
      for (const b of bytes) {
        const h = b.toString(16)
        escaped += "%" + (h.length === 1 ? "0" + h : h)
      }
      return decodeURIComponent(escaped)
    } catch {
      return null
    }
  }

  function tryParseAuthJson(ctx, text) {
    if (!text) return null
    const parsed = ctx.util.tryParseJson(text)
    if (parsed !== null) return parsed

    // Some keychain payloads can be returned as hex-encoded UTF-8 bytes.
    let hex = String(text).trim()
    if (hex.startsWith("0x") || hex.startsWith("0X")) hex = hex.slice(2)
    if (!hex || hex.length % 2 !== 0) return null
    if (!/^[0-9a-fA-F]+$/.test(hex)) return null

    const decoded = decodeHexUtf8(hex)
    if (!decoded) return null
    return ctx.util.tryParseJson(decoded)
  }

  function looksLikeJwt(value) {
    return /^[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+$/.test(value)
  }

  function normalizeAuthPayload(raw, opts) {
    const allowPartial = Boolean(opts && opts.allowPartial)
    if (!raw || typeof raw !== "object") return null

    const accessToken =
      raw.access_token ||
      raw.accessToken ||
      (raw.tokens && (raw.tokens.access_token || raw.tokens.accessToken))

    const refreshToken =
      raw.refresh_token ||
      raw.refreshToken ||
      (raw.tokens && (raw.tokens.refresh_token || raw.tokens.refreshToken))

    const hasAccess = typeof accessToken === "string" && accessToken
    const hasRefresh = typeof refreshToken === "string" && refreshToken
    if (!hasAccess && !(allowPartial && hasRefresh)) return null

    return {
      access_token: hasAccess ? accessToken : null,
      refresh_token: hasRefresh ? refreshToken : null,
    }
  }

  function parseAuthPayload(ctx, rawText, opts) {
    const parsed = tryParseAuthJson(ctx, rawText)
    const normalized = normalizeAuthPayload(parsed, opts)
    if (normalized) return normalized

    if (typeof parsed === "string" && looksLikeJwt(parsed)) {
      return { access_token: parsed, refresh_token: null }
    }

    const direct = String(rawText || "").trim()
    if (looksLikeJwt(direct)) {
      return { access_token: direct, refresh_token: null }
    }

    return null
  }

  function loadAuth(ctx) {
    const auth = normalizeAuthPayload(ctx.credentials, { allowPartial: true })
    return auth ? { auth } : null
  }

  function credentialsJson(authState) {
    const auth = authState.auth
    return JSON.stringify({
      type: "oauth",
      accessToken: auth.access_token || "",
      refreshToken: auth.refresh_token || "",
    })
  }

  function getAccessTokenExpiryMs(ctx, accessToken) {
    const payload = ctx.jwt.decodePayload(accessToken)
    return payload && typeof payload.exp === "number" ? payload.exp * 1000 : null
  }

  function needsRefresh(ctx, accessToken, nowMs) {
    return ctx.util.needsRefreshByExpiry({
      nowMs,
      expiresAtMs: getAccessTokenExpiryMs(ctx, accessToken),
      bufferMs: TOKEN_REFRESH_THRESHOLD_MS,
    })
  }

  function canUseExistingAccessToken(ctx, accessToken, nowMs) {
    const expiresAtMs = getAccessTokenExpiryMs(ctx, accessToken)
    return typeof expiresAtMs === "number" && nowMs < expiresAtMs
  }

  function refreshToken(ctx, authState) {
    const auth = authState.auth
    if (!auth.refresh_token) {
      ctx.host.log.warn("refresh skipped: no refresh token")
      return null
    }

    ctx.host.log.info("attempting token refresh via WorkOS")
    try {
      const resp = ctx.util.request({
        method: "POST",
        url: WORKOS_AUTH_URL,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        bodyText:
          "grant_type=refresh_token" +
          "&refresh_token=" + encodeURIComponent(auth.refresh_token) +
          "&client_id=" + encodeURIComponent(WORKOS_CLIENT_ID),
        timeoutMs: 15000,
      })

      if (resp.status === 400 || resp.status === 401) {
        ctx.host.log.error("refresh failed: status=" + resp.status)
        throw "Session expired. Run `droid` to log in again."
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

      // Update auth object with new tokens
      auth.access_token = newAccessToken
      if (body.refresh_token) {
        auth.refresh_token = body.refresh_token
      }

      ctx.host.log.info("refresh succeeded")

      return newAccessToken
    } catch (e) {
      if (typeof e === "string") throw e
      ctx.host.log.error("refresh exception: " + String(e))
      return null
    }
  }

  function fetchUsage(ctx, accessToken) {
    var resp = ctx.util.request({
      method: "POST",
      url: USAGE_URL,
      headers: {
        Authorization: "Bearer " + accessToken,
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "OpenUsage",
      },
      bodyText: JSON.stringify({ useCache: true }),
      timeoutMs: 10000,
    })
    if (resp.status === 405) {
      ctx.host.log.info("POST returned 405, retrying with GET")
      resp = ctx.util.request({
        method: "GET",
        url: USAGE_URL,
        headers: {
          Authorization: "Bearer " + accessToken,
          Accept: "application/json",
          "User-Agent": "OpenUsage",
        },
        timeoutMs: 10000,
      })
    }
    return resp
  }

  function probe(ctx) {
    const authState = loadAuth(ctx)
    if (!authState) {
      ctx.host.log.error("probe failed: not logged in")
      throw "Not logged in. Run `droid` to authenticate."
    }

    const auth = authState.auth
    if (!auth.access_token) {
      ctx.host.log.error("probe failed: no access_token in auth data")
      throw "Invalid auth credentials. Run `droid` to authenticate."
    }

    let accessToken = auth.access_token

    // Check if token needs refresh
    const nowMs = Date.now()
    if (needsRefresh(ctx, accessToken, nowMs)) {
      ctx.host.log.info("token near expiry, refreshing")
      try {
        const refreshed = refreshToken(ctx, authState)
        if (refreshed) {
          accessToken = refreshed
        } else {
          ctx.host.log.warn("proactive refresh failed, trying with existing token")
        }
      } catch (e) {
        if (!canUseExistingAccessToken(ctx, accessToken, nowMs)) throw e
        ctx.host.log.warn("proactive refresh failed but access token is still valid, trying existing token")
      }
    }

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
          return refreshToken(ctx, authState)
        },
      })
    } catch (e) {
      if (typeof e === "string") throw e
      ctx.host.log.error("usage request failed: " + String(e))
      throw "Usage request failed. Check your connection."
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      ctx.host.log.error("usage returned auth error after all retries: status=" + resp.status)
      throw "Token expired. Run `droid` to log in again."
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

    const usage = data.usage
    if (!usage) {
      throw "Usage response missing data. Try again later."
    }

    const lines = []

    // Calculate reset time and period from usage dates
    const endDate = usage.endDate
    const startDate = usage.startDate
    const resetsAt = typeof endDate === "number" ? ctx.util.toIso(endDate) : null
    const periodDurationMs = (typeof endDate === "number" && typeof startDate === "number")
      ? (endDate - startDate)
      : null

    // Standard tokens (primary line)
    const standard = usage.standard
    if (standard && typeof standard.totalAllowance === "number") {
      const used = standard.orgTotalTokensUsed || 0
      const limit = standard.totalAllowance
      lines.push(ctx.line.progress({
        label: "Standard",
        used: used,
        limit: limit,
        format: { kind: "count", suffix: "tokens" },
        resetsAt: resetsAt,
        periodDurationMs: periodDurationMs,
      }))
    }

    // Premium tokens (detail line, only if plan includes premium)
    const premium = usage.premium
    if (premium && typeof premium.totalAllowance === "number" && premium.totalAllowance > 0) {
      const used = premium.orgTotalTokensUsed || 0
      const limit = premium.totalAllowance
      lines.push(ctx.line.progress({
        label: "Premium",
        used: used,
        limit: limit,
        format: { kind: "count", suffix: "tokens" },
        resetsAt: resetsAt,
        periodDurationMs: periodDurationMs,
      }))
    }

    // Infer plan from allowance
    let plan = null
    if (standard && typeof standard.totalAllowance === "number") {
      const allowance = standard.totalAllowance
      if (allowance >= 200000000) {
        plan = "Max"
      } else if (allowance >= 20000000) {
        plan = "Pro"
      } else if (allowance > 0) {
        plan = "Basic"
      }
    }

    if (lines.length === 0) {
      lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))
    }

    return { plan: plan, lines: lines, updatedCredentialsJson: credentialsJson(authState) }
  }

  globalThis.__openusage_plugin = { id: "factory", probe }
})()
