# OpenRouter

Tracks [OpenRouter](https://openrouter.ai) credits and API key limits.

## Overview

- **Protocol:** REST JSON
- **Base URL:** `https://openrouter.ai/api/v1`
- **Auth:** API key via `OPENROUTER_API_KEY` or account credentials
- **Credits:** account-level credits and usage in dollars
- **Key quota:** optional API-key limit and usage in dollars
- **Rate limit:** optional requests per interval from key metadata

## Setup

1. Create an API key in [OpenRouter Keys](https://openrouter.ai/settings/keys)
2. Add an OpenRouter account in OpenBurn settings, or set `OPENROUTER_API_KEY`

Optional account JSON fields:

```json
{
  "apiKey": "YOUR_API_KEY",
  "apiHost": "https://openrouter.ai/api/v1"
}
```

## Endpoints

### GET /credits

Returns total account credits and account usage.

Used fields:

- `data.total_credits`
- `data.total_usage`

### GET /key

Best-effort. Returns metadata for the current API key.

Used fields:

- `data.label` - plan/card label
- `data.limit` - key usage limit
- `data.usage` - key usage
- `data.rate_limit.requests`
- `data.rate_limit.interval`

## Displayed Lines

| Line       | Description |
|------------|-------------|
| Credits    | Total account usage over total account credits |
| Key Quota  | Current API key usage over key limit |
| Rate Limit | Request limit for the current key |

## Errors

| Condition | Message |
|-----------|---------|
| No API key | "OpenRouter API key missing. Add an OpenRouter account in Settings." |
| 401/403 | "OpenRouter API key is invalid or expired." |
| HTTP error | "Request failed (HTTP {status}). Try again later." |
| Invalid JSON | "OpenRouter response invalid. Try again later." |
