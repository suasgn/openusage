# OpenCode Auth Rotation

OpenBurn can sync a saved account into OpenCode's `auth.json`, then rotate to the account with the most usage left.

Supported now: `codex`, `zai`.

## Manual Sync

In OpenBurn settings:

1. Add multiple accounts for `codex` or `zai`.
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
  -d '{"pluginId":"codex"}'
```

Use `{"pluginId":"zai"}` for Z.ai.

## OpenCode CLI Hook

Create `~/.config/opencode/plugins/openburn-auth-rotate.ts`:

```ts
import type { Plugin } from "@opencode-ai/plugin"

const PLUGIN_ID = "codex" // use "zai" for Z.ai
const ROTATE_URL = "http://127.0.0.1:6736/v1/external-auth/opencode/rotate"
const ROTATE_COOLDOWN_MS = 10_000
const LIMIT_RE = /429|too many requests|rate.?limit|usage.?limit|limit has been reached|reached.*limit|quota|insufficient_quota|FreeUsageLimitError|out of (extra )?usage|credit/i
const NON_USAGE_LIMIT_RE = /context|prompt.*too long|input.*too long|output length|max.*tokens|token limit|context_length|model_context_window/i

type PluginClient = Parameters<Plugin>[0]["client"]

let rotating = false
const lastRotateBySession = new Map<string, number>()

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
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
  const now = Date.now()
  const lastRotate = lastRotateBySession.get(sessionId) ?? 0
  if (rotating || now - lastRotate < ROTATE_COOLDOWN_MS) return

  rotating = true
  lastRotateBySession.set(sessionId, now)
  try {
    const response = await fetch(ROTATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pluginId: PLUGIN_ID }),
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
        message: `OpenBurn rotated ${result.pluginId} to ${result.accountLabel}. Press Esc and resend if OpenCode is waiting to retry.`,
      },
    })
  } finally {
    rotating = false
  }
}

export const OpenBurnAuthRotate: Plugin = async ({ client }) => ({
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
