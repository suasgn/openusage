export type ProgressFormat =
  | { kind: "percent" }
  | { kind: "dollars" }
  | { kind: "count"; suffix: string }

export type MetricLine =
  | { type: "text"; label: string; value: string; color?: string; subtitle?: string }
  | {
      type: "progress"
      label: string
      used: number
      limit: number
      format: ProgressFormat
      resetsAt?: string
      periodDurationMs?: number
      color?: string
    }
  | { type: "badge"; label: string; text: string; color?: string; subtitle?: string }

export type ManifestLine = {
  type: "text" | "progress" | "badge"
  label: string
  scope: "overview" | "detail"
}

export type PluginLink = {
  label: string
  url: string
}

export type PluginOutput = {
  pluginId: string
  displayName: string
  plan?: string
  lines: MetricLine[]
  iconUrl: string
}

export type PluginMeta = {
  id: string
  name: string
  iconUrl: string
  brandColor?: string
  lines: ManifestLine[]
  links?: PluginLink[]
  auth?: PluginAuth
  /** Ordered list of primary metric candidates. Frontend picks first available. */
  primaryCandidates: string[]
}

export type AuthStrategyKind = "apiKey" | "json" | "oauthPkce" | "deviceCode" | "browserCookie"

export type AuthCredentialField = {
  name: string
  label: string
  secret?: boolean
  required?: boolean
  placeholder?: string | null
}

export type AuthStrategy = {
  id: string
  label: string
  kind: AuthStrategyKind
  fields: AuthCredentialField[]
  credentialTemplate?: unknown
}

export type PluginAuth = {
  defaultStrategyId?: string | null
  strategies: AuthStrategy[]
}

export type PluginDisplayState = {
  meta: PluginMeta
  data: PluginOutput | null
  loading: boolean
  error: string | null
  lastManualRefreshAt: number | null
}
