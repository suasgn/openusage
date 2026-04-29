import type { PluginMeta, PluginOutput } from "@/lib/plugin-types"
import type { PluginSettings } from "@/lib/settings"
import { DEFAULT_DISPLAY_MODE, getEnabledPluginIds, type DisplayMode } from "@/lib/settings"
import { getBaseMetricLabel } from "@/lib/account-scoped-label"
import { clamp01 } from "@/lib/utils"

type PluginState = {
  data: PluginOutput | null
  loading: boolean
  error: string | null
}

export type TrayPrimaryBar = {
  id: string
  fraction?: number
}

type ProgressLine = Extract<
  PluginOutput["lines"][number],
  { type: "progress"; label: string; used: number; limit: number }
>

function isProgressLine(line: PluginOutput["lines"][number]): line is ProgressLine {
  return line.type === "progress"
}

function hasPrimaryCandidates(meta: PluginMeta): boolean {
  return Array.isArray(meta.primaryCandidates) && meta.primaryCandidates.length > 0
}

function aggregateFraction(lines: ProgressLine[], displayMode: DisplayMode): number | undefined {
  const valid = lines.filter(
    (line) => Number.isFinite(line.used) && Number.isFinite(line.limit) && line.limit > 0
  )
  if (valid.length === 0) return undefined

  const totalLimit = valid.reduce((sum, line) => sum + line.limit, 0)
  if (!Number.isFinite(totalLimit) || totalLimit <= 0) return undefined

  const totalUsed = valid.reduce((sum, line) => sum + line.used, 0)
  const shownAmount = displayMode === "used" ? totalUsed : totalLimit - totalUsed
  return clamp01(shownAmount / totalLimit)
}

function primaryProgressLines(meta: PluginMeta, data: PluginOutput | null): ProgressLine[] {
  if (!data) return []
  const primaryLabel = meta.primaryCandidates.find((label) =>
    data.lines.some((line) => isProgressLine(line) && getBaseMetricLabel(line.label) === label)
  )
  if (!primaryLabel) return []

  return data.lines.filter(
    (line): line is ProgressLine =>
      isProgressLine(line) && getBaseMetricLabel(line.label) === primaryLabel
  )
}

export function getTrayPrimaryBars(args: {
  pluginsMeta: PluginMeta[]
  pluginSettings: PluginSettings | null
  pluginStates: Record<string, PluginState | undefined>
  maxBars?: number
  displayMode?: DisplayMode
  pluginId?: string
}): TrayPrimaryBar[] {
  const {
    pluginsMeta,
    pluginSettings,
    pluginStates,
    maxBars = 4,
    displayMode = DEFAULT_DISPLAY_MODE,
    pluginId,
  } = args
  if (!pluginSettings) return []

  const metaById = new Map(pluginsMeta.map((p) => [p.id, p]))
  const orderedIds = pluginId
    ? [pluginId]
    : getEnabledPluginIds(pluginSettings)

  const out: TrayPrimaryBar[] = []
  for (const id of orderedIds) {
    const meta = metaById.get(id)
    if (!meta) continue

    // Skip if no primary candidates defined
    if (!hasPrimaryCandidates(meta)) continue

    const state = pluginStates[id]
    const data = state?.data ?? null

    let fraction: number | undefined
    if (data) {
      fraction = aggregateFraction(primaryProgressLines(meta, data), displayMode)
    }

    out.push({ id, fraction })
    if (out.length >= maxBars) break
  }

  return out
}

export function getTrayPrimaryTotalBar(args: {
  pluginsMeta: PluginMeta[]
  pluginSettings: PluginSettings | null
  pluginStates: Record<string, PluginState | undefined>
  displayMode?: DisplayMode
}): TrayPrimaryBar | null {
  const {
    pluginsMeta,
    pluginSettings,
    pluginStates,
    displayMode = DEFAULT_DISPLAY_MODE,
  } = args
  if (!pluginSettings) return null

  const metaById = new Map(pluginsMeta.map((plugin) => [plugin.id, plugin]))
  const lines: ProgressLine[] = []
  let hasAnyCandidate = false

  for (const id of getEnabledPluginIds(pluginSettings)) {
    const meta = metaById.get(id)
    if (!meta || !hasPrimaryCandidates(meta)) continue
    hasAnyCandidate = true
    lines.push(...primaryProgressLines(meta, pluginStates[id]?.data ?? null))
  }

  if (!hasAnyCandidate) return null
  return { id: "overview", fraction: aggregateFraction(lines, displayMode) }
}
