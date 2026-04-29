# Kilo

Tracks [Kilo](https://kilo.ai) credit blocks and Kilo Pass usage.

> Reverse-engineered from Kilo's app tRPC API. It may change without notice.

## Overview

- **Protocol:** tRPC batch JSON
- **Base URL:** `https://app.kilo.ai/api/trpc`
- **Auth:** API key via `KILO_API_KEY` or account credentials
- **Credits:** prepaid credit blocks, converted from `*_mUsd` fields to dollars
- **Kilo Pass:** current billing period spend against included base + bonus credits

## Setup

1. Add a Kilo account in OpenBurn settings, or set `KILO_API_KEY`
2. Enter the Kilo API key/token

Optional account JSON fields:

```json
{
  "apiKey": "YOUR_API_KEY",
  "apiHost": "https://app.kilo.ai/api/trpc"
}
```

Accepted API key aliases: `api_key`, `token`, `access_token`, `authToken`.

## Endpoints

OpenBurn calls one tRPC batch request with two procedures:

- `user.getCreditBlocks`
- `kiloPass.getState`

The old fork also called `user.getAutoTopUpPaymentMethod`, but that response was unused, so this plugin skips it.

Used fields:

- `creditBlocks[*].amount_mUsd`
- `creditBlocks[*].balance_mUsd`
- `subscription.currentPeriodUsageUsd`
- `subscription.currentPeriodBaseCreditsUsd`
- `subscription.currentPeriodBonusCreditsUsd`
- `subscription.nextBillingAt`
- `subscription.nextRenewalAt`
- `subscription.renewsAt`
- `subscription.renewAt`
- `subscription.tier`

## Displayed Lines

| Line           | Description |
|----------------|-------------|
| Credits        | Used credit blocks as a percentage |
| Credit Balance | Used/total credit blocks, rounded |
| Kilo Pass      | Current pass spend over current pass credits |
| Pass Details   | Base and bonus split when bonus credits exist |

## Errors

| Condition | Message |
|-----------|---------|
| No API key | "Kilo API key missing. Add a Kilo account in Settings." |
| 401/403 | "Kilo authentication failed. Check your API key." |
| tRPC auth error | "Kilo authentication failed." |
| 404 | "Kilo API endpoint not found (404)." |
| 5xx | "Kilo API unavailable (HTTP {status}). Try again later." |
| Invalid JSON | "Kilo response invalid. Try again later." |
