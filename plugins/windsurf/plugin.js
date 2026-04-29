(function () {
  var CLOUD_SERVICE = "exa.seat_management_pb.SeatManagementService"
  var CLOUD_URL = "https://server.self-serve.windsurf.com"
  var CLOUD_COMPAT_VERSION = "1.108.2"
  var LOGIN_HINT = "Start Windsurf or sign in and try again."
  var QUOTA_HINT = "Windsurf quota data unavailable. Try again later."
  var DAY_MS = 24 * 60 * 60 * 1000
  var WEEK_MS = 7 * DAY_MS

  var DEFAULT_VARIANT = { marker: "windsurf", ideName: "windsurf" }

  function readFiniteNumber(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null
    if (typeof value !== "string") return null
    var trimmed = value.trim()
    if (!trimmed) return null
    var parsed = Number(trimmed)
    return Number.isFinite(parsed) ? parsed : null
  }

  function clampPercent(value) {
    if (!Number.isFinite(value)) return 0
    if (value < 0) return 0
    if (value > 100) return 100
    return value
  }

  function loadAccountAuth(ctx) {
    var creds = ctx.credentials
    if (!creds || typeof creds !== "object" || !creds.apiKey) return null
    var ideName = typeof creds.ideName === "string" && creds.ideName.trim()
      ? creds.ideName.trim()
      : DEFAULT_VARIANT.ideName
    return {
      apiKey: String(creds.apiKey).trim(),
      variant: {
        marker: ideName,
        ideName: ideName,
      },
    }
  }

  function callCloud(ctx, apiKey, variant) {
    try {
      var resp = ctx.host.http.request({
        method: "POST",
        url: CLOUD_URL + "/" + CLOUD_SERVICE + "/GetUserStatus",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
        },
        bodyText: JSON.stringify({
          metadata: {
            apiKey: apiKey,
            ideName: variant.ideName,
            ideVersion: CLOUD_COMPAT_VERSION,
            extensionName: variant.ideName,
            extensionVersion: CLOUD_COMPAT_VERSION,
            locale: "en",
          },
        }),
        timeoutMs: 15000,
      })
      if (resp.status < 200 || resp.status >= 300) {
        ctx.host.log.warn("cloud request returned status " + resp.status + " for " + variant.marker)
        if (ctx.util && typeof ctx.util.isAuthStatus === "function" && ctx.util.isAuthStatus(resp.status)) {
          return { __openusageAuthError: true }
        }
        return null
      }
      return ctx.util.tryParseJson(resp.bodyText)
    } catch (e) {
      ctx.host.log.warn("cloud request failed for " + variant.marker + ": " + String(e))
      return null
    }
  }

  function unixSecondsToIso(ctx, value) {
    var seconds = readFiniteNumber(value)
    if (seconds === null) return null
    return ctx.util.toIso(seconds * 1000)
  }

  function formatDollarsFromMicros(value) {
    var micros = readFiniteNumber(value)
    if (micros === null) return null
    if (!Number.isFinite(micros)) return null
    if (micros < 0) micros = 0
    return "$" + (micros / 1000000).toFixed(2)
  }

  function buildQuotaLine(ctx, label, remainingPercent, resetsAt, periodDurationMs) {
    var remaining = readFiniteNumber(remainingPercent)
    if (remaining === null) return null
    var line = {
      label: label,
      used: clampPercent(100 - remaining),
      limit: 100,
      format: { kind: "percent" },
      periodDurationMs: periodDurationMs,
    }
    if (resetsAt) line.resetsAt = resetsAt
    return ctx.line.progress(line)
  }

  function hasQuotaContract(planStatus) {
    return (
      readFiniteNumber(planStatus && planStatus.dailyQuotaRemainingPercent) !== null &&
      readFiniteNumber(planStatus && planStatus.weeklyQuotaRemainingPercent) !== null &&
      readFiniteNumber(planStatus && planStatus.dailyQuotaResetAtUnix) !== null &&
      readFiniteNumber(planStatus && planStatus.weeklyQuotaResetAtUnix) !== null
    )
  }

  function buildOutput(ctx, userStatus) {
    var planStatus = (userStatus && userStatus.planStatus) || {}
    if (!hasQuotaContract(planStatus)) throw QUOTA_HINT

    var planInfo = planStatus.planInfo || {}
    var planName = typeof planInfo.planName === "string" && planInfo.planName.trim()
      ? planInfo.planName.trim()
      : "Unknown"

    var dailyReset = unixSecondsToIso(ctx, planStatus.dailyQuotaResetAtUnix)
    var weeklyReset = unixSecondsToIso(ctx, planStatus.weeklyQuotaResetAtUnix)
    var extraUsageBalance = formatDollarsFromMicros(planStatus.overageBalanceMicros)

    if (!dailyReset || !weeklyReset) throw QUOTA_HINT

    var dailyLine = buildQuotaLine(ctx, "Daily quota", planStatus.dailyQuotaRemainingPercent, dailyReset, DAY_MS)
    var weeklyLine = buildQuotaLine(ctx, "Weekly quota", planStatus.weeklyQuotaRemainingPercent, weeklyReset, WEEK_MS)

    if (!dailyLine || !weeklyLine) throw QUOTA_HINT

    var lines = [dailyLine, weeklyLine]
    if (extraUsageBalance) {
      lines.push(ctx.line.text({ label: "Extra usage balance", value: extraUsageBalance }))
    }

    return {
      plan: planName,
      lines: lines,
    }
  }

  function probe(ctx) {
    var auth = loadAccountAuth(ctx)
    if (!auth || !auth.apiKey) throw LOGIN_HINT

    var data = callCloud(ctx, auth.apiKey, auth.variant)
    if (data && data.__openusageAuthError) throw LOGIN_HINT
    if (!data || !data.userStatus) throw QUOTA_HINT

    try {
      return buildOutput(ctx, data.userStatus)
    } catch (e) {
      if (e === QUOTA_HINT) {
        ctx.host.log.warn("quota contract unavailable for " + auth.variant.marker)
      }
      throw e
    }
  }

  globalThis.__openusage_plugin = { id: "windsurf", probe: probe }
})()
