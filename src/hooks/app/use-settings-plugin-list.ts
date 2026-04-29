import { useMemo } from "react"
import type { PluginMeta } from "@/lib/plugin-types"
import type { PluginSettings } from "@/lib/settings"

export type SettingsPluginState = {
  id: string
  name: string
  enabled: boolean
  auth?: PluginMeta["auth"]
  externalAuth?: PluginMeta["externalAuth"]
}

type UseSettingsPluginListArgs = {
  pluginSettings: PluginSettings | null
  pluginsMeta: PluginMeta[]
}

export function useSettingsPluginList({ pluginSettings, pluginsMeta }: UseSettingsPluginListArgs) {
  return useMemo<SettingsPluginState[]>(() => {
    if (!pluginSettings) return []
    const pluginMap = new Map(pluginsMeta.map((plugin) => [plugin.id, plugin]))
    const disabled = new Set(pluginSettings.disabled ?? [])

    return pluginSettings.order
      .map<SettingsPluginState | null>((id) => {
        const meta = pluginMap.get(id)
        if (!meta) return null
        return {
          id,
          name: meta.name,
          enabled: !disabled.has(id),
          auth: meta.auth,
          externalAuth: meta.externalAuth,
        }
      })
      .filter((plugin): plugin is SettingsPluginState => plugin !== null)
  }, [pluginSettings, pluginsMeta])
}
