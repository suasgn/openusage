(function () {
  var LS_SERVICE = "exa.language_server_pb.LanguageServerService"
  var CLOUD_CODE_URLS = [
    "https://daily-cloudcode-pa.googleapis.com",
    "https://daily-cloudcode-pa.sandbox.googleapis.com",
    "https://autopush-cloudcode-pa.sandbox.googleapis.com",
    "https://cloudcode-pa.googleapis.com",
  ]
  var FETCH_MODELS_PATH = "/v1internal:fetchAvailableModels"
  var GOOGLE_OAUTH_URL = "https://oauth2.googleapis.com/token"
  var GOOGLE_CLIENT_ID = "1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com"
  var GOOGLE_CLIENT_SECRET = "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"
  var CC_MODEL_BLACKLIST = {
    "MODEL_CHAT_20706": true,
    "MODEL_CHAT_23310": true,
    "MODEL_GOOGLE_GEMINI_2_5_FLASH": true,
    "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING": true,
    "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE": true,
    "MODEL_GOOGLE_GEMINI_2_5_PRO": true,
    "MODEL_PLACEHOLDER_M19": true,
    "MODEL_PLACEHOLDER_M9": true,
    "MODEL_PLACEHOLDER_M12": true,
  }
  function normalizeExpirySeconds(value) {
    var numberValue = Number(value)
    if (!isFinite(numberValue) || numberValue <= 0) return null
    if (numberValue > 100000000000) return Math.floor(numberValue / 1000)
    return Math.floor(numberValue)
  }

  function parseRefreshTokenParts(raw) {
    var parts = String(raw || "").split("|")
    return {
      refreshToken: parts[0] || "",
      projectId: parts[1] || null,
      managedProjectId: parts[2] || null,
    }
  }

  function loadAccountTokens(ctx) {
    var creds = ctx.credentials
    if (!creds || typeof creds !== "object") return null
    if (!creds.accessToken && !creds.refreshToken) return null
    var refreshParts = parseRefreshTokenParts(creds.refreshToken)
    return {
      accessToken: creds.accessToken || "",
      refreshToken: refreshParts.refreshToken,
      expirySeconds: normalizeExpirySeconds(creds.expiresAt),
      projectId: creds.projectId || refreshParts.projectId || null,
      managedProjectId: creds.managedProjectId || refreshParts.managedProjectId || null,
    }
  }

  function tokenNeedsRefresh(tokens) {
    if (!tokens || !tokens.accessToken) return true
    if (!tokens.expirySeconds) return false
    return tokens.expirySeconds <= Math.floor(Date.now() / 1000) + 60
  }

  function accountCredentialsJson(tokens) {
    return JSON.stringify({
      type: "oauth",
      accessToken: tokens.accessToken || "",
      refreshToken: tokens.refreshToken || "",
      expiresAt: tokens.expirySeconds || null,
      projectId: tokens.projectId || null,
      managedProjectId: tokens.managedProjectId || null,
    })
  }

  // --- Google OAuth token refresh ---

  function refreshOAuthTokens(ctx, refreshTokenValue, existingTokens) {
    if (!refreshTokenValue) {
      ctx.host.log.warn("refresh skipped: no refresh token")
      return null
    }
    ctx.host.log.info("attempting Google OAuth token refresh")
    try {
      var resp = ctx.host.http.request({
        method: "POST",
        url: GOOGLE_OAUTH_URL,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        bodyText:
          "client_id=" + encodeURIComponent(GOOGLE_CLIENT_ID) +
          "&client_secret=" + encodeURIComponent(GOOGLE_CLIENT_SECRET) +
          "&refresh_token=" + encodeURIComponent(refreshTokenValue) +
          "&grant_type=refresh_token",
        timeoutMs: 15000,
      })
      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.warn("Google OAuth refresh returned status: " + resp.status)
        return null
      }
      var body = ctx.util.tryParseJson(resp.bodyText)
      if (!body || !body.access_token) {
        ctx.host.log.warn("Google OAuth refresh response missing access_token")
        return null
      }
      var expiresIn = (typeof body.expires_in === "number") ? body.expires_in : 3600
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token || refreshTokenValue,
        expirySeconds: Math.floor(Date.now() / 1000) + expiresIn,
        projectId: existingTokens ? existingTokens.projectId : null,
        managedProjectId: existingTokens ? existingTokens.managedProjectId : null,
      }
    } catch (e) {
      ctx.host.log.warn("Google OAuth refresh failed: " + String(e))
      return null
    }
  }

  // --- LS discovery ---

  function discoverLs(ctx) {
    return ctx.host.ls.discover({
      processName: "language_server_macos",
      markers: ["antigravity"],
      csrfFlag: "--csrf_token",
      portFlag: "--extension_server_port",
    })
  }

  function probePort(ctx, scheme, port, csrf) {
    ctx.host.http.request({
      method: "POST",
      url: scheme + "://127.0.0.1:" + port + "/" + LS_SERVICE + "/GetUnleashData",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": csrf,
      },
      bodyText: JSON.stringify({
        context: {
          properties: {
            devMode: "false",
            extensionVersion: "unknown",
            ide: "antigravity",
            ideVersion: "unknown",
            os: "macos",
          },
        },
      }),
      timeoutMs: 5000,
      dangerouslyIgnoreTls: scheme === "https",
    })
    // Any HTTP response means this port is alive (even 400 validation errors).
    return true
  }

  function findWorkingPort(ctx, discovery) {
    var ports = discovery.ports || []
    for (var i = 0; i < ports.length; i++) {
      var port = ports[i]
      // Try HTTPS first (LS may use self-signed cert), then HTTP
      try { if (probePort(ctx, "https", port, discovery.csrf)) return { port: port, scheme: "https" } } catch (e) { /* ignore */ }
      try { if (probePort(ctx, "http", port, discovery.csrf)) return { port: port, scheme: "http" } } catch (e) { /* ignore */ }
      ctx.host.log.info("port " + port + " probe failed on both schemes")
    }
    if (discovery.extensionPort) return { port: discovery.extensionPort, scheme: "http" }
    return null
  }

  function callLs(ctx, port, scheme, csrf, method, body) {
    var resp = ctx.host.http.request({
      method: "POST",
      url: scheme + "://127.0.0.1:" + port + "/" + LS_SERVICE + "/" + method,
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "x-codeium-csrf-token": csrf,
      },
      bodyText: JSON.stringify(body || {}),
      timeoutMs: 10000,
      dangerouslyIgnoreTls: scheme === "https",
    })
    if (resp.status < 200 || resp.status >= 300) {
      ctx.host.log.warn("callLs " + method + " returned " + resp.status)
      return null
    }
    return ctx.util.tryParseJson(resp.bodyText)
  }

  // --- Line builders ---

  function normalizeLabel(label) {
    // "Gemini 3 Pro (High)" -> "Gemini 3 Pro"
    return label.replace(/\s*\([^)]*\)\s*$/, "").trim()
  }

  function poolLabel(normalizedLabel) {
    var lower = normalizedLabel.toLowerCase()
    if (lower.indexOf("gemini") !== -1 && lower.indexOf("pro") !== -1) return "Gemini Pro"
    if (lower.indexOf("gemini") !== -1 && lower.indexOf("flash") !== -1) return "Gemini Flash"
    // All non-Gemini models (Claude, GPT-OSS, etc.) share a single quota pool
    return "Claude"
  }

  function modelSortKey(label) {
    var lower = label.toLowerCase()
    // Gemini Pro variants first, then other Gemini, then Claude Opus, then other Claude, then rest
    if (lower.indexOf("gemini") !== -1 && lower.indexOf("pro") !== -1) return "0a_" + label
    if (lower.indexOf("gemini") !== -1) return "0b_" + label
    if (lower.indexOf("claude") !== -1 && lower.indexOf("opus") !== -1) return "1a_" + label
    if (lower.indexOf("claude") !== -1) return "1b_" + label
    return "2_" + label
  }

  var QUOTA_PERIOD_MS = 5 * 60 * 60 * 1000 // 5 hours

  function modelLine(ctx, label, remainingFraction, resetTime) {
    var clamped = Math.max(0, Math.min(1, remainingFraction))
    var used = Math.round((1 - clamped) * 100)
    return ctx.line.progress({
      label: label,
      used: used,
      limit: 100,
      format: { kind: "percent" },
      resetsAt: resetTime || undefined,
      periodDurationMs: QUOTA_PERIOD_MS,
    })
  }

  function buildModelLines(ctx, configs) {
    var deduped = {}
    for (var i = 0; i < configs.length; i++) {
      var c = configs[i]
      var label = (typeof c.label === "string") ? c.label.trim() : ""
      if (!label) continue
      var qi = c.quotaInfo
      var frac = (qi && typeof qi.remainingFraction === "number") ? qi.remainingFraction : 0
      var rtime = (qi && qi.resetTime) || undefined
      var pool = poolLabel(normalizeLabel(label))
      if (!deduped[pool] || frac < deduped[pool].remainingFraction) {
        deduped[pool] = {
          label: pool,
          remainingFraction: frac,
          resetTime: rtime,
        }
      }
    }

    var models = []
    var keys = Object.keys(deduped)
    for (var i = 0; i < keys.length; i++) {
      var m = deduped[keys[i]]
      m.sortKey = modelSortKey(m.label)
      models.push(m)
    }

    models.sort(function (a, b) {
      return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0
    })

    var lines = []
    for (var i = 0; i < models.length; i++) {
      lines.push(modelLine(ctx, models[i].label, models[i].remainingFraction, models[i].resetTime))
    }
    return lines
  }

  // --- Cloud Code API ---

  function probeCloudCode(ctx, token) {
    for (var i = 0; i < CLOUD_CODE_URLS.length; i++) {
      try {
        var resp = ctx.host.http.request({
          method: "POST",
          url: CLOUD_CODE_URLS[i] + FETCH_MODELS_PATH,
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
            "User-Agent": "antigravity",
          },
          bodyText: "{}",
          timeoutMs: 15000,
        })
        if (ctx.util.isAuthStatus(resp.status)) return { _authFailed: true }
        if (resp.status >= 200 && resp.status < 300) {
          return ctx.util.tryParseJson(resp.bodyText)
        }
      } catch (e) {
        ctx.host.log.warn("Cloud Code request failed (" + CLOUD_CODE_URLS[i] + "): " + String(e))
      }
    }
    return null
  }

  function parseCloudCodeModels(data) {
    var modelsObj = data && data.models
    if (!modelsObj || typeof modelsObj !== "object") return []
    var keys = Object.keys(modelsObj)
    var configs = []
    for (var i = 0; i < keys.length; i++) {
      var m = modelsObj[keys[i]]
      if (!m || typeof m !== "object") continue
      if (m.isInternal) continue
      var modelId = m.model || keys[i]
      if (CC_MODEL_BLACKLIST[modelId]) continue
      var displayName = (typeof m.displayName === "string") ? m.displayName.trim() : ""
      if (!displayName) continue
      var qi = m.quotaInfo
      var frac = (qi && typeof qi.remainingFraction === "number") ? qi.remainingFraction : 0
      var rtime = (qi && qi.resetTime) || undefined
      configs.push({
        label: displayName,
        quotaInfo: { remainingFraction: frac, resetTime: rtime },
      })
    }
    return configs
  }

  // --- LS probe ---

  function probeLs(ctx) {
    var discovery = discoverLs(ctx)
    if (!discovery) return null

    var found = findWorkingPort(ctx, discovery)
    if (!found) return null

    ctx.host.log.info("using LS at " + found.scheme + "://127.0.0.1:" + found.port)

    var metadata = {
      ideName: "antigravity",
      extensionName: "antigravity",
      ideVersion: "unknown",
      locale: "en",
    }

    // Try GetUserStatus first, fall back to GetCommandModelConfigs
    var data = null
    try {
      data = callLs(ctx, found.port, found.scheme, discovery.csrf, "GetUserStatus", { metadata: metadata })
    } catch (e) {
      ctx.host.log.warn("GetUserStatus threw: " + String(e))
    }
    var hasUserStatus = data && data.userStatus

    if (!hasUserStatus) {
      ctx.host.log.warn("GetUserStatus failed, trying GetCommandModelConfigs")
      data = callLs(ctx, found.port, found.scheme, discovery.csrf, "GetCommandModelConfigs", { metadata: metadata })
    }

    // Parse model configs
    var configs
    if (hasUserStatus) {
      configs = (data.userStatus.cascadeModelConfigData || {}).clientModelConfigs || []
    } else if (data && data.clientModelConfigs) {
      configs = data.clientModelConfigs
    } else {
      return null
    }

    var filtered = []
    for (var j = 0; j < configs.length; j++) {
      var mid = configs[j].modelOrAlias && configs[j].modelOrAlias.model
      if (mid && CC_MODEL_BLACKLIST[mid]) continue
      filtered.push(configs[j])
    }

    var lines = buildModelLines(ctx, filtered)
    if (lines.length === 0) return null

    var plan = null
    if (hasUserStatus) {
      // Prefer userTier.name (Google's own subscription system) over the legacy
      // planInfo.planName field inherited from Windsurf/Codeium, which always
      // returns "Pro" for all paid tiers including Google AI Ultra.
      var ut = data.userStatus.userTier
      var userTierName =
        ut && typeof ut.name === "string" && ut.name.trim() ? ut.name.trim() : null
      if (userTierName) {
        plan = userTierName
      } else {
        var ps = data.userStatus.planStatus || {}
        var pi = ps.planInfo || {}
        plan =
          typeof pi.planName === "string" && pi.planName.trim() ? pi.planName.trim() : null
      }
    }

    return { plan: plan, lines: lines }
  }

  function probeAccount(ctx, accountTokens) {
    var tokens = accountTokens
    var updated = false

    if (tokenNeedsRefresh(tokens)) {
      if (!tokens.refreshToken) {
        throw "Antigravity OAuth credentials are expired and missing refresh token."
      }
      var refreshed = refreshOAuthTokens(ctx, tokens.refreshToken, tokens)
      if (refreshed) {
        tokens = refreshed
        updated = true
      } else if (!tokens.accessToken) {
        throw "Token expired. Reconnect Antigravity account."
      }
    }

    var ccData = tokens.accessToken ? probeCloudCode(ctx, tokens.accessToken) : null
    if (ccData && ccData._authFailed && tokens.refreshToken) {
      var retry = refreshOAuthTokens(ctx, tokens.refreshToken, tokens)
      if (retry) {
        tokens = retry
        updated = true
        ccData = probeCloudCode(ctx, tokens.accessToken)
      }
    }

    if (ccData && !ccData._authFailed) {
      var configs = parseCloudCodeModels(ccData)
      var lines = buildModelLines(ctx, configs)
      if (lines.length > 0) {
        var result = { plan: null, lines: lines }
        if (updated || accountTokens.projectId || accountTokens.managedProjectId) {
          result.updatedCredentialsJson = accountCredentialsJson(tokens)
        }
        return result
      }
    }

    throw "Antigravity usage unavailable. Start Antigravity and try again."
  }

  // --- Probe ---

  function probe(ctx) {
    var accountTokens = loadAccountTokens(ctx)
    if (accountTokens) return probeAccount(ctx, accountTokens)

    var lsResult = probeLs(ctx)
    if (lsResult) return lsResult

    throw "Start Antigravity and try again."
  }

  globalThis.__openusage_plugin = { id: "antigravity", probe: probe }
})()
