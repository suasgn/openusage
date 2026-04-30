# OpenCode Auth Rotation

OpenBurn can sync a saved account into OpenCode's `auth.json`, then rotate to the account with the most usage left.

Supported now: `codex`, `copilot`, `kilo`, `minimax`, `openrouter`, `zai`.

## Manual Sync

In OpenBurn settings:

1. Add multiple accounts for a supported provider.
2. Refresh usage once so OpenBurn has cached usage per account.
3. Open an account and click **Sync OpenCode auth**.

This writes the selected account to `~/.local/share/opencode/auth.json`.

## Local API

```bash
curl -X POST http://127.0.0.1:6736/v1/external-auth/opencode/sync \
  -H 'Content-Type: application/json' \
  -d '{"accountId":"ACCOUNT_ID"}'
```

```bash
curl -X POST http://127.0.0.1:6736/v1/external-auth/opencode/rotate \
  -H 'Content-Type: application/json' \
  -d '{"opencodeAuthKey":"openai"}'
```

Other OpenCode auth keys include `github-copilot`, `kilo`, `minimax`, `openrouter`, and `zai-coding-plan`.

`pluginId` is still supported for direct OpenBurn plugin ids, for example `{"pluginId":"codex"}` or `{"pluginId":"zai"}`.

## OpenCode CLI Hook

Create `~/.config/opencode/plugins/openburn-auth-rotate.ts`:

```ts
import type { Plugin } from "@opencode-ai/plugin"

const ROTATE_URL = "http://127.0.0.1:6736/v1/external-auth/opencode/rotate"
const ROTATE_COOLDOWN_MS = 10_000
const LIMIT_RE = /429|too many requests|rate.?limit|usage.?limit|limit has been reached|reached.*limit|quota|insufficient_quota|FreeUsageLimitError|out of (extra )?usage|credit/i
const NON_USAGE_LIMIT_RE = /context|prompt.*too long|input.*too long|output length|max.*tokens|token limit|context_length|model_context_window/i

type PluginClient = Parameters<Plugin>[0]["client"]
type CurrentModel = { providerID: string; modelID: string }

let rotating = false
const lastRotateBySession = new Map<string, number>()
const currentModelBySession = new Map<string, CurrentModel>()

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error
  const data = asRecord(asRecord(error).data)
  let serialized = ""
  try {
    serialized = JSON.stringify(error)
  } catch {}

  return [data.message, data.responseBody, serialized]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .join("\n")
}

function errorStatus(error: unknown): number | undefined {
  const status = asRecord(asRecord(error).data).statusCode
  return typeof status === "number" ? status : undefined
}

function isUsageLimit(text: string, status?: number): boolean {
  if (NON_USAGE_LIMIT_RE.test(text)) return false
  return status === 429 || LIMIT_RE.test(text)
}

async function rotate(client: PluginClient, sessionId: string) {
  const current = currentModelBySession.get(sessionId)
  if (!current) return

  const now = Date.now()
  const lastRotate = lastRotateBySession.get(sessionId) ?? 0
  if (rotating || now - lastRotate < ROTATE_COOLDOWN_MS) return

  rotating = true
  lastRotateBySession.set(sessionId, now)
  try {
    const response = await fetch(ROTATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        opencodeAuthKey: current.providerID,
        modelId: current.modelID,
      }),
    })

    const text = await response.text()
    if (!response.ok) {
      await client.tui.showToast({
        body: {
          variant: "error",
          message: `OpenBurn auth rotation failed: ${text.slice(0, 180)}`,
        },
      })
      return
    }

    const result = JSON.parse(text) as { pluginId: string; accountLabel: string }
    await client.tui.showToast({
      body: {
        variant: "success",
        message: `OpenBurn rotated ${current.providerID} (${result.pluginId}) to ${result.accountLabel}. Press Esc and resend if OpenCode is waiting to retry.`,
      },
    })
  } finally {
    rotating = false
  }
}

export const OpenBurnAuthRotate: Plugin = async ({ client }) => ({
  "chat.params": async (input) => {
    const model = input.model as { providerID?: string; id?: string; modelID?: string }
    const providerID = stringValue(model.providerID)
    const modelID = stringValue(model.id) ?? stringValue(model.modelID) ?? "unknown"
    if (!providerID) return
    currentModelBySession.set(input.sessionID, { providerID, modelID })
  },

  event: async ({ event }) => {
    const evt = event as { type: string; properties?: Record<string, unknown> }

    if (evt.type === "session.status") {
      const status = asRecord(evt.properties?.status)
      if (status?.type !== "retry") return
      const message = String(status.message || "")
      if (!isUsageLimit(message)) return
      await rotate(client, String(evt.properties?.sessionID || "global"))
      return
    }

    if (evt.type !== "session.error") return
    const error = evt.properties?.error
    const message = errorText(error)
    if (!isUsageLimit(message, errorStatus(error))) return
    await rotate(client, String(evt.properties?.sessionID || "global"))
  },
})
```

Restart OpenCode after adding the plugin.

Note: when OpenCode is waiting on a retry countdown, auth is rotated but the current request may keep waiting. Press Esc, then send the prompt again after the toast.
