# OpenCode Auth Rotation

OpenUsage can sync a saved account into OpenCode's `auth.json`, then rotate to the account with the most usage left.

Supported now: `codex`, `zai`.

## Manual Sync

In OpenUsage settings:

1. Add multiple accounts for `codex` or `zai`.
2. Refresh usage once so OpenUsage has cached usage per account.
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

Create `~/.config/opencode/plugins/openusage-auth-rotate.ts`:

```ts
import type { Plugin } from "@opencode-ai/plugin"

const PLUGIN_ID = "codex" // use "zai" for Z.ai
const ROTATE_URL = "http://127.0.0.1:6736/v1/external-auth/opencode/rotate"
const LIMIT_RE = /rate.?limit|usage.?limit|quota|credit|429/i

export const OpenUsageAuthRotate: Plugin = async ({ client }) => ({
  event: async ({ event }) => {
    if (event.type !== "session.error") return

    const error = event.properties?.error
    const statusCode = error?.data?.statusCode
    const message = String(error?.data?.message || "")
    if (statusCode !== 429 && !LIMIT_RE.test(message)) return

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
          message: `OpenUsage auth rotation failed: ${text.slice(0, 180)}`,
        },
      })
      return
    }

    const result = JSON.parse(text) as { pluginId: string; accountLabel: string }
    await client.tui.showToast({
      body: {
        variant: "success",
        message: `OpenUsage rotated ${result.pluginId} to ${result.accountLabel}`,
      },
    })
  },
})
```

Restart OpenCode after adding the plugin.

Note: the failed request is not retried automatically. Send the prompt again after the toast.
