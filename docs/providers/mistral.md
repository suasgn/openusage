# Mistral

Tracks monthly Mistral API billing usage from the Mistral admin console.

## Overview

- **Protocol:** REST JSON
- **Endpoint:** `https://admin.mistral.ai/api/billing/v2/usage?month=<M>&year=<Y>`
- **Auth:** Mistral admin console cookie (`ory_session_*`)
- **Data:** monthly cost, input tokens, output tokens, cached tokens, model count

## Setup

1. Add a Mistral account in OpenBurn settings.
2. Use Cookie Login and sign in to `admin.mistral.ai`, or paste a manual Cookie header from the admin console.

Manual account JSON:

```json
{
  "cookieHeader": "ory_session_...=...; csrftoken=..."
}
```

## Endpoint

### GET /api/billing/v2/usage

Used fields:

- `completion.models` token entries
- `ocr.models`, `connectors.models`, `audio.models`
- `libraries_api.pages.models`, `libraries_api.tokens.models`
- `fine_tuning.training`, `fine_tuning.storage`
- `prices[].billing_metric`, `prices[].billing_group`, `prices[].price`
- `currency`, `currency_symbol`, `start_date`, `end_date`

Cost is computed locally from `value_paid` or `value` multiplied by the matching price entry.

## Displayed Lines

| Line | Description |
|------|-------------|
| Cost | Computed monthly cost |
| Input Tokens | Completion input tokens |
| Output Tokens | Completion output tokens |
| Cached Tokens | Completion cached tokens when present |
| Models | Count of completion models with usage rows |
| Status | No-usage state |

## Errors

| Condition | Message |
|-----------|---------|
| No cookie | "Mistral session cookie missing. Add a Mistral account in Settings." |
| Missing session cookie | "Mistral session cookie is missing ory_session_*. Re-authenticate in Settings." |
| 401/403 | "Mistral session cookie is invalid or expired." |
| HTTP error | "Request failed (HTTP {status}). Try again later." |
| Invalid JSON | "Mistral response invalid. Try again later." |
