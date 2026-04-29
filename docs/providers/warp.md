# Warp

Tracks [Warp](https://www.warp.dev) request credits and add-on credits.

> Reverse-engineered from Warp's app GraphQL API. It may change without notice.

## Overview

- **Protocol:** GraphQL JSON
- **Endpoint:** `https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo`
- **Auth:** API key via `WARP_API_KEY` or account credentials
- **Credits:** daily request limit usage as a percentage
- **Add-on credits:** bonus grants across user and workspace grants

## Setup

1. Add a Warp account in OpenBurn settings, or set `WARP_API_KEY`
2. Enter the Warp API key/token

Account JSON fields:

```json
{
  "apiKey": "YOUR_API_KEY"
}
```

Accepted aliases: `api_key`, `token`, `access_token`, `authToken`.

## Endpoint

### GetRequestLimitInfo

```http
POST https://app.warp.dev/graphql/v2?op=GetRequestLimitInfo
Authorization: Bearer <apiKey>
Content-Type: application/json
```

Used fields:

- `requestLimitInfo.isUnlimited`
- `requestLimitInfo.nextRefreshTime`
- `requestLimitInfo.requestLimit`
- `requestLimitInfo.requestsUsedSinceLastRefresh`
- `bonusGrants[*].requestCreditsGranted`
- `bonusGrants[*].requestCreditsRemaining`
- `workspaces[*].bonusGrantsInfo.grants[*].requestCreditsGranted`
- `workspaces[*].bonusGrantsInfo.grants[*].requestCreditsRemaining`

## Displayed Lines

| Line           | Description |
|----------------|-------------|
| Credits        | Used daily request credits as a percentage |
| Add-on Credits | Used bonus/add-on credits as a percentage |
| Status         | Unlimited or no usage data fallback |

## Errors

| Condition | Message |
|-----------|---------|
| No API key | "Warp API key missing. Add a Warp account in Settings." |
| 401/403 | "Warp API key is invalid or expired." |
| GraphQL error | "Warp API error: {message}" |
| Invalid JSON | "Warp response invalid. Try again later." |
