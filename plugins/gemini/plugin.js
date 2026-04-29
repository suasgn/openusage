(function () {
  const LOAD_CODE_ASSIST_URL = "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist"
  const QUOTA_URL = "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota"
  const PROJECTS_URL = "https://cloudresourcemanager.googleapis.com/v1/projects"
  const TOKEN_URL = "https://oauth2.googleapis.com/token"
  const OAUTH_CLIENT_ID = "681255809395-oo8ft2oprdrnp9e3aqf6av3hmdib135j.apps.googleusercontent.com"
  const OAUTH_CLIENT_SECRET = "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"
  const REFRESH_BUFFER_MS = 5 * 60 * 1000

  const IDE_METADATA = {
    ideType: "IDE_UNSPECIFIED",
    platform: "PLATFORM_UNSPECIFIED",
    pluginType: "GEMINI",
    duetProject: "default",
  }

  function normalizeExpiryMs(value) {
    const n = Number(value)
    if (!Number.isFinite(n) || n <= 0) return undefined
    return n > 10_000_000_000 ? n : n * 1000
  }

  function loadOauthCreds(ctx) {
    const source = ctx.credentials
    if (!source || typeof source !== "object") return null
    const accessToken = source.accessToken || source.access_token || ""
    const refreshToken = source.refreshToken || source.refresh_token || ""
    const idToken = source.idToken || source.id_token || ""
    if (!accessToken && !refreshToken && !idToken) return null
    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      id_token: idToken,
      expiry_date: normalizeExpiryMs(source.expiresAt || source.expiryDate || source.expiry_date),
      client_id: source.clientId || source.client_id || OAUTH_CLIENT_ID,
      client_secret: source.clientSecret || source.client_secret || OAUTH_CLIENT_SECRET,
    }
  }

  function readNumber(value) {
    const n = Number(value)
    return Number.isFinite(n) ? n : null
  }

  function decodeIdToken(ctx, token) {
    if (typeof token !== "string" || !token) return null
    try {
      const payload = ctx.jwt.decodePayload(token)
      return payload && typeof payload === "object" ? payload : null
    } catch {
      return null
    }
  }

  function needsRefresh(creds) {
    if (!creds.access_token) return true
    const expiry = readNumber(creds.expiry_date)
    if (expiry === null) return false
    const expiryMs = expiry > 10_000_000_000 ? expiry : expiry * 1000
    return Date.now() + REFRESH_BUFFER_MS >= expiryMs
  }

  function refreshToken(ctx, creds) {
    if (!creds.refresh_token) return null
    const clientId = creds.client_id || OAUTH_CLIENT_ID
    const clientSecret = creds.client_secret || OAUTH_CLIENT_SECRET

    let resp
    try {
      resp = ctx.util.request({
        method: "POST",
        url: TOKEN_URL,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        bodyText:
          "client_id=" +
          encodeURIComponent(clientId) +
          "&client_secret=" +
          encodeURIComponent(clientSecret) +
          "&refresh_token=" +
          encodeURIComponent(creds.refresh_token) +
          "&grant_type=refresh_token",
        timeoutMs: 15000,
      })
    } catch (e) {
      ctx.host.log.warn("refresh request failed: " + String(e))
      return null
    }

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "Gemini session expired. Run `gemini` and re-authenticate when prompted."
    }
    if (resp.status < 200 || resp.status >= 300) return null

    const data = ctx.util.tryParseJson(resp.bodyText)
    if (!data || typeof data.access_token !== "string" || !data.access_token) return null

    creds.access_token = data.access_token
    if (typeof data.id_token === "string" && data.id_token) creds.id_token = data.id_token
    if (typeof data.refresh_token === "string" && data.refresh_token) creds.refresh_token = data.refresh_token
    if (typeof data.expires_in === "number") {
      creds.expiry_date = Date.now() + data.expires_in * 1000
    }

    return creds.access_token
  }

  function credentialsJson(creds) {
    return JSON.stringify({
      type: "oauth",
      accessToken: creds.access_token || "",
      refreshToken: creds.refresh_token || "",
      idToken: creds.id_token || "",
      expiresAt: creds.expiry_date ? Math.floor(Number(creds.expiry_date) / 1000) : null,
      clientId: creds.client_id || OAUTH_CLIENT_ID,
      clientSecret: creds.client_secret || OAUTH_CLIENT_SECRET,
    })
  }

  function postJson(ctx, url, accessToken, body) {
    return ctx.util.request({
      method: "POST",
      url,
      headers: {
        Authorization: "Bearer " + accessToken,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      bodyText: JSON.stringify(body || {}),
      timeoutMs: 10000,
    })
  }

  function readFirstStringDeep(value, keys) {
    if (!value || typeof value !== "object") return null

    for (let i = 0; i < keys.length; i += 1) {
      const v = value[keys[i]]
      if (typeof v === "string" && v.trim()) return v.trim()
    }

    const nested = Object.values(value)
    for (let i = 0; i < nested.length; i += 1) {
      const found = readFirstStringDeep(nested[i], keys)
      if (found) return found
    }
    return null
  }

  function mapTierToPlan(tier, idTokenPayload) {
    if (!tier) return null
    const normalized = String(tier).trim().toLowerCase()
    if (normalized === "standard-tier") return "Paid"
    if (normalized === "legacy-tier") return "Legacy"
    if (normalized === "free-tier") return idTokenPayload && idTokenPayload.hd ? "Workspace" : "Free"
    return null
  }

  function discoverProjectId(ctx, accessToken, loadCodeAssistData) {
    const fromLoadCodeAssist = readFirstStringDeep(loadCodeAssistData, ["cloudaicompanionProject"])
    if (fromLoadCodeAssist) return fromLoadCodeAssist

    let projectsResp
    try {
      projectsResp = ctx.util.request({
        method: "GET",
        url: PROJECTS_URL,
        headers: { Authorization: "Bearer " + accessToken, Accept: "application/json" },
        timeoutMs: 10000,
      })
    } catch (e) {
      ctx.host.log.warn("project discovery failed: " + String(e))
      return null
    }

    if (projectsResp.status < 200 || projectsResp.status >= 300) return null
    const projectsData = ctx.util.tryParseJson(projectsResp.bodyText)
    const projects = projectsData && Array.isArray(projectsData.projects) ? projectsData.projects : []
    for (let i = 0; i < projects.length; i += 1) {
      const project = projects[i]
      const projectId = project && typeof project.projectId === "string" ? project.projectId : null
      if (!projectId) continue
      if (projectId.indexOf("gen-lang-client") === 0) return projectId
      const labels = project && project.labels && typeof project.labels === "object" ? project.labels : null
      if (labels && labels["generative-language"] !== undefined) return projectId
    }
    return null
  }

  function collectQuotaBuckets(value, out) {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i += 1) collectQuotaBuckets(value[i], out)
      return
    }
    if (!value || typeof value !== "object") return

    if (typeof value.remainingFraction === "number") {
      const modelId =
        typeof value.modelId === "string"
          ? value.modelId
          : typeof value.model_id === "string"
            ? value.model_id
            : "unknown"
      out.push({
        modelId,
        remainingFraction: value.remainingFraction,
        resetTime: value.resetTime || value.reset_time || null,
      })
    }

    const nested = Object.values(value)
    for (let i = 0; i < nested.length; i += 1) collectQuotaBuckets(nested[i], out)
  }

  function pickLowestRemainingBucket(buckets) {
    let best = null
    for (let i = 0; i < buckets.length; i += 1) {
      const bucket = buckets[i]
      if (!Number.isFinite(bucket.remainingFraction)) continue
      if (!best || bucket.remainingFraction < best.remainingFraction) best = bucket
    }
    return best
  }

  function toUsageLine(ctx, label, bucket) {
    const clampedRemaining = Math.max(0, Math.min(1, Number(bucket.remainingFraction)))
    const used = Math.round((1 - clampedRemaining) * 100)
    const resetsAt = ctx.util.toIso(bucket.resetTime)
    const opts = {
      label,
      used,
      limit: 100,
      format: { kind: "percent" },
    }
    if (resetsAt) opts.resetsAt = resetsAt
    return ctx.line.progress(opts)
  }

  function parseQuotaLines(ctx, quotaData) {
    const buckets = []
    collectQuotaBuckets(quotaData, buckets)
    if (!buckets.length) return []

    const proBuckets = []
    const flashBuckets = []
    for (let i = 0; i < buckets.length; i += 1) {
      const bucket = buckets[i]
      const lower = String(bucket.modelId || "").toLowerCase()
      if (lower.indexOf("gemini") !== -1 && lower.indexOf("pro") !== -1) {
        proBuckets.push(bucket)
      } else if (lower.indexOf("gemini") !== -1 && lower.indexOf("flash") !== -1) {
        flashBuckets.push(bucket)
      }
    }

    const lines = []
    const pro = pickLowestRemainingBucket(proBuckets)
    if (pro) lines.push(toUsageLine(ctx, "Pro", pro))
    const flash = pickLowestRemainingBucket(flashBuckets)
    if (flash) lines.push(toUsageLine(ctx, "Flash", flash))
    return lines
  }

  function fetchLoadCodeAssist(ctx, accessToken, creds) {
    let currentToken = accessToken
    const resp = ctx.util.retryOnceOnAuth({
      request: function (token) {
        return postJson(ctx, LOAD_CODE_ASSIST_URL, token || currentToken, { metadata: IDE_METADATA })
      },
      refresh: function () {
        const refreshed = refreshToken(ctx, creds)
        if (refreshed) currentToken = refreshed
        return refreshed
      },
    })

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "Gemini session expired. Run `gemini` and re-authenticate when prompted."
    }
    if (resp.status < 200 || resp.status >= 300) return { data: null, accessToken: currentToken }
    return { data: ctx.util.tryParseJson(resp.bodyText), accessToken: currentToken }
  }

  function fetchQuotaWithRetry(ctx, accessToken, creds, projectId) {
    let currentToken = accessToken
    const resp = ctx.util.retryOnceOnAuth({
      request: function (token) {
        const body = projectId ? { project: projectId } : {}
        return postJson(ctx, QUOTA_URL, token || currentToken, body)
      },
      refresh: function () {
        const refreshed = refreshToken(ctx, creds)
        if (refreshed) currentToken = refreshed
        return refreshed
      },
    })

    if (ctx.util.isAuthStatus(resp.status)) {
      throw "Gemini session expired. Run `gemini` and re-authenticate when prompted."
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw "Gemini quota request failed (HTTP " + String(resp.status) + "). Try again later."
    }
    return resp
  }

  function probe(ctx) {
    const creds = loadOauthCreds(ctx)
    if (!creds) throw "Not logged in. Run `gemini` and complete the OAuth prompt."

    let accessToken = creds.access_token
    if (needsRefresh(creds)) {
      const refreshed = refreshToken(ctx, creds)
      if (refreshed) accessToken = refreshed
      else if (!accessToken) throw "Not logged in. Run `gemini` and complete the OAuth prompt."
    }

    const idTokenPayload = decodeIdToken(ctx, creds.id_token)
    const loadCodeAssistResult = fetchLoadCodeAssist(ctx, accessToken, creds)
    accessToken = loadCodeAssistResult.accessToken

    const tier = readFirstStringDeep(loadCodeAssistResult.data, ["tier", "userTier", "subscriptionTier"])
    const plan = mapTierToPlan(tier, idTokenPayload)

    const projectId = discoverProjectId(ctx, accessToken, loadCodeAssistResult.data)
    const quotaResp = fetchQuotaWithRetry(ctx, accessToken, creds, projectId)
    const quotaData = ctx.util.tryParseJson(quotaResp.bodyText)
    if (!quotaData || typeof quotaData !== "object") {
      throw "Gemini quota response invalid. Try again later."
    }

    const lines = parseQuotaLines(ctx, quotaData)
    const email = idTokenPayload && typeof idTokenPayload.email === "string" ? idTokenPayload.email : null
    if (email) lines.push(ctx.line.text({ label: "Account", value: email }))
    if (!lines.length) lines.push(ctx.line.badge({ label: "Status", text: "No usage data", color: "#a3a3a3" }))

    return { plan: plan || undefined, lines, updatedCredentialsJson: credentialsJson(creds) }
  }

  globalThis.__openusage_plugin = { id: "gemini", probe }
})()
