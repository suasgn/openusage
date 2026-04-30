# DeepSeek

Tracks DeepSeek API credit balance.

## Overview

- **Protocol:** REST JSON
- **Endpoint:** `https://api.deepseek.com/user/balance`
- **Auth:** API key via `DEEPSEEK_API_KEY`, `DEEPSEEK_KEY`, or account credentials
- **Data:** current balance, paid balance, granted balance

## Setup

1. Create an API key in the DeepSeek platform.
2. Add a DeepSeek account in OpenBurn settings, or set `DEEPSEEK_API_KEY`.

Optional account JSON:

```json
{
  "apiKey": "YOUR_API_KEY"
}
```

## Endpoint

### GET /user/balance

Used fields:

- `is_available`
- `balance_infos[].currency`
- `balance_infos[].total_balance`
- `balance_infos[].granted_balance`
- `balance_infos[].topped_up_balance`

USD is preferred when multiple currency entries are returned.

## Displayed Lines

| Line | Description |
|------|-------------|
| Balance | Current total balance |
| Paid | Paid/top-up balance |
| Granted | Promotional granted balance |
| Status | Unavailable or no-credit state |

## Errors

| Condition | Message |
|-----------|---------|
| No API key | "DeepSeek API key missing. Add a DeepSeek account in Settings." |
| 401/403 | "DeepSeek API key is invalid or expired." |
| HTTP error | "Request failed (HTTP {status}). Try again later." |
| Invalid JSON | "DeepSeek response invalid. Try again later." |
