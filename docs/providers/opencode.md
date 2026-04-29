# OpenCode

Tracks [OpenCode](https://opencode.ai) subscription usage using the logged-in browser session.

> Reverse-engineered from OpenCode's web app. The server function IDs and payload shape may change without notice.

## Overview

- **Auth:** browser cookie capture from `https://opencode.ai/auth`
- **Cookie sources:** `https://opencode.ai/_server`, `/workspace/`, `/auth`
- **Required cookie:** `auth` or `__Host-auth`
- **Usage source:** OpenCode `_server` functions and `/workspace/<id>/go`
- **Workspace:** discovered automatically, or set manually as `workspaceId`

## Setup

1. Add an OpenCode account in OpenBurn settings
2. Choose **Cookie Login**
3. Sign in in the opened OpenCode window and wait until it reaches a `/workspace/wrk_...` URL

Manual credentials are also supported:

```json
{
  "cookieHeader": "auth=...",
  "workspaceId": "wrk_..."
}
```

## Endpoints

### Workspace Discovery

```http
GET https://opencode.ai/_server?id=<workspace-server-id>
Cookie: <cookieHeader>
X-Server-Id: <workspace-server-id>
```

Used to find the first `wrk_...` workspace ID if one is not configured.

### Subscription Usage

```http
GET https://opencode.ai/_server?id=<subscription-server-id>&args=["wrk_..."]
Cookie: <cookieHeader>
X-Server-Id: <subscription-server-id>
Referer: https://opencode.ai/workspace/<workspaceId>/billing
```

Used fields/patterns:

- `rollingUsage.usagePercent`
- `rollingUsage.resetInSec`
- `weeklyUsage.usagePercent`
- `weeklyUsage.resetInSec`
- `planType`, `subscriptionType`, `planName`
- `usage[*].totalCost`
- `usage[*].subscription`

### Go Usage

```http
GET https://opencode.ai/workspace/<workspaceId>/go
Cookie: <cookieHeader>
```

Used fields/patterns:

- `rollingUsage.usagePercent`
- `rollingUsage.resetInSec`
- `weeklyUsage.usagePercent`
- `weeklyUsage.resetInSec`
- `monthlyUsage.usagePercent`
- `monthlyUsage.resetInSec`

## Displayed Lines

| Line | Description |
|---|---|
| Session | Subscription session usage |
| Weekly | Subscription weekly usage |
| Monthly Cost | Sum of monthly subscription usage rows when present |
| Go Session | OpenCode Go session usage from the web account |
| Go Weekly | OpenCode Go weekly usage from the web account |
| Go Monthly | OpenCode Go monthly usage from the web account |
| Subscription Rows | Diagnostic count when subscription rows differ from usage rows |

## Errors

| Condition | Message |
|---|---|
| Missing/expired cookie | "OpenCode session cookie is invalid or expired." |
| Missing workspace | "OpenCode parse error: Missing workspace id." |
| Missing subscription payload | "OpenCode API error: No subscription usage data was returned..." |
| Missing Go payload | "OpenCode Go parse error: Missing usage fields." |
