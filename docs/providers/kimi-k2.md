# Kimi K2

Tracks Kimi K2 API credits.

## Overview

- **Protocol:** REST JSON
- **Endpoint:** `https://kimi-k2.ai/api/user/credits`
- **Auth:** API key via `KIMI_K2_API_KEY`, `KIMI_API_KEY`, `KIMI_KEY`, or account credentials
- **Data:** consumed credits, remaining credits, optional average tokens per request

## Setup

1. Create or copy a Kimi K2 API key.
2. Add a Kimi K2 account in OpenBurn settings, or set `KIMI_K2_API_KEY`.

Optional account JSON:

```json
{
  "apiKey": "YOUR_API_KEY"
}
```

## Endpoint

### GET /api/user/credits

Used fields, depending on response shape:

- `total_credits_consumed`, `totalCreditsConsumed`, `total_credits_used`, `credits_consumed`
- `credits_remaining`, `remaining_credits`, `available_credits`, `credits_left`
- `usage.total`, `usage.consumed`, `usage.remaining`
- `average_tokens_per_request`, `average_tokens`, `avg_tokens`
- Header fallback: `X-Credits-Remaining`

## Displayed Lines

| Line | Description |
|------|-------------|
| Credits | Consumed credits over consumed + remaining |
| Remaining | Remaining credits |
| Avg Tokens | Optional average tokens per request |
| Status | No-credit state |

## Errors

| Condition | Message |
|-----------|---------|
| No API key | "Kimi K2 API key missing. Add a Kimi K2 account in Settings." |
| 401/403 | "Kimi K2 API key is invalid or expired." |
| Missing usage fields | "Kimi K2 credits response missing usage data. Try again later." |
| Invalid JSON | "Kimi K2 response invalid. Try again later." |
