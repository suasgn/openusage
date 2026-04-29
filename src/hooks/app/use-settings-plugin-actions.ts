import { useCallback } from "react"
import { track } from "@/lib/analytics"
import { savePluginSettings, type PluginSettings } from "@/lib/settings"

const TRAY_SETTINGS_DEBOUNCE_MS = 2000

type ScheduleTrayIconUpdate = (reason: "probe" | "settings" | "init", delayMs?: number) => void

type UseSettingsPluginActionsArgs = {
  pluginSettings: PluginSettings | null
  setPluginSettings: (value: PluginSettings | null) => void
  scheduleTrayIconUpdate: ScheduleTrayIconUpdate
}

export function useSettingsPluginActions({
  pluginSettings,
  setPluginSettings,
  scheduleTrayIconUpdate,
}: UseSettingsPluginActionsArgs) {
  const handleReorder = useCallback((orderedIds: string[]) => {
    if (!pluginSettings) return
    track("providers_reordered", { count: orderedIds.length })
    // orderedIds can be a subset if the caller only reorders visible items.
    // Re-insert missing IDs at their original relative positions so no plugin is dropped.
    const orderedSet = new Set(orderedIds)
    const missing = (pluginSettings.order ?? []).filter((id) => !orderedSet.has(id))
    const merged = [...orderedIds]
    for (const id of missing) {
      const prevIdx = (pluginSettings.order ?? []).indexOf(id)
      // Insert after the last merged entry whose original index < prevIdx
      let insertAt = 0 // default: prepend if id originally preceded all visible entries
      for (let i = merged.length - 1; i >= 0; i--) {
        const mergedPrevIdx = (pluginSettings.order ?? []).indexOf(merged[i])
        if (mergedPrevIdx < prevIdx) {
          insertAt = i + 1
          break
        }
      }
      merged.splice(insertAt, 0, id)
    }
    const nextSettings: PluginSettings = {
      ...pluginSettings,
      order: merged,
    }
    setPluginSettings(nextSettings)
    scheduleTrayIconUpdate("settings", TRAY_SETTINGS_DEBOUNCE_MS)
    void savePluginSettings(nextSettings).catch((error) => {
      console.error("Failed to save plugin order:", error)
    })
  }, [pluginSettings, scheduleTrayIconUpdate, setPluginSettings])

  const handleToggle = useCallback((id: string, enabled: boolean) => {
    if (!pluginSettings) return
    track("provider_toggled", { provider_id: id, enabled: enabled ? "true" : "false" })
    const disabledSet = new Set(pluginSettings.disabled ?? [])
    if (enabled) {
      disabledSet.delete(id)
    } else {
      disabledSet.add(id)
    }
    const nextSettings: PluginSettings = {
      ...pluginSettings,
      disabled: (pluginSettings.order ?? []).filter((pluginId) => disabledSet.has(pluginId)),
    }
    setPluginSettings(nextSettings)
    scheduleTrayIconUpdate("settings", TRAY_SETTINGS_DEBOUNCE_MS)
    void savePluginSettings(nextSettings).catch((error) => {
      console.error("Failed to save plugin enabled state:", error)
    })
  }, [pluginSettings, scheduleTrayIconUpdate, setPluginSettings])

  return {
    handleReorder,
    handleToggle,
  }
}
