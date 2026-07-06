# Hyperliquid Tracker

## Owner

- Tracker: `src/services/trackers/hyperliquid.ts`
- API client: `src/services/api/hyperliquid.ts`
- DB service: `src/services/db/hyperliquid.ts`

## What It Does

Monitors Hyperliquid perp and spot trade activity, aggregates by wallet/coin/direction, and posts high-value alerts to dedicated Telegram channels per branch. Also supports manual wallet tracking workflows.

## Ingestion

- Loads coin universe and spot pairs at start.
- Builds socket groups and subscribes to `trades` channels.
- Handles message payloads in `handleTrade(...)`.

Normalization details:

- Perps:
  - Buy taker -> `long`
  - Sell taker -> `short`
- Spot:
  - Buyer and seller aggregate independently as `spot_buy` / `spot_sell`; both record positive notional, so a seller's `totalNotional` is the cumulative USD sold over the window.

## Aggregation and Scan

- Buffers records in `tradeBatch`.
- Flushes via `flushTradeBatch()` on interval and size threshold.
- Uses `affectedKeys` to limit scans to touched wallet+position keys.
- Runs `scanAndAlert()` loop for candidate processing.
- Runs `trackAndAlert()` loop for manually tracked wallets.

## Alert Rules

Candidates are classified into one of four alert branches:

1. **Fresh Wallet** — wallet first seen < 50h ago (configurable via `HL_FRESH_WINDOW_MS`). Tiered thresholds:
  - Main coins (BTC, ETH, BNB, XRP, ZEC, DOGE, SOL, HYPE): >= $450K (`HL_FRESH_MAIN_COIN_MIN_USD`)
  - Other coins: >= $200K (`HL_FRESH_MIN_USD`)

2. **Whale Activity** — wallet > 50h old, position >= $300K (`HL_WHALE_MIN_USD`)

3. **Big Whale** — any wallet, position >= $1M (`HL_BIG_WHALE_MIN_USD`)

4. **Big TWAP** — perp or spot buy/sell accumulation executed as a burst of same-direction fills. A candidate qualifies only when the most recent contiguous burst (consecutive fills each <= 60s apart, `HL_TWAP_MAX_GAP_MS`):
   - the coin is one of BTC, ETH, SOL, XRP, DOGE, HYPE, BNB,
   - has >= 5 fills (`HL_TWAP_MIN_FILLS`),
   - has an average interval between fills <= 45s (`HL_TWAP_MAX_INTERVAL_MS`),
   - the traded notional within the burst meets the per-coin minimum:
     - BTC: >= $19M (`HL_TWAP_BTC_MIN_USD`)
     - ETH: >= $8M (`HL_TWAP_ETH_MIN_USD`)
     - SOL: >= $5M (`HL_TWAP_SOL_MIN_USD`)
     - XRP: >= $4M (`HL_TWAP_XRP_MIN_USD`)
     - DOGE: >= $4M (`HL_TWAP_DOGE_MIN_USD`)
     - HYPE: >= $5M (`HL_TWAP_HYPE_MIN_USD`)
     - BNB: >= $5M (`HL_TWAP_BNB_MIN_USD`)

  The alert size, cycle stats and re-alert growth all reflect this burst. Perp TWAP alerts fire in addition to the position-based branch (Fresh/Whale/Big Whale) and are labelled `[PERP]`; spot alerts are labelled `[SPOT]`. Trades for any other coin are still ingested and aggregated for analysis but never produce a TWAP alert. Sell-side TWAPs (short / spot_sell) render with red 'selling' styling on the same channel.

Re-alert only when growth exceeds dynamic threshold:

- max(percent growth threshold, fixed USD threshold)

`mainCoins` list: BTC, ETH, BNB, XRP, ZEC, DOGE, SOL, HYPE.

Alert destinations:

- Each branch routes to its own dedicated channel (Fresh Wallet, Whale Activity, Big Whale, TWAP).
- Manual track updates route to dedicated tracking channel.

## Manual Tracking

Command wiring in `src/index.ts`:

- `/track <wallet> <coin> <long|short>`
- `/untrack <wallet> <coin> <long|short>`
- `/tracked`
- `/stats <coin>`

Callback workflows:

- `track:<id>` and `untrack:<id>` inline actions are handled via Telegram callback actions.

## Persistence

`src/services/db/hyperliquid.ts` manages:

- Aggregations collection.
- Sent alerts collection.
- Tracked wallet collection.

Common operations:

- Bulk upsert on flush.
- Candidate reads for scan loop.
- Alert history reads for re-alert logic.
- TTL-like cleanup loops for old records.

## Health and Recovery

- No-data watchdog can force websocket reconnect.
- Scan watchdog detects stalled scan loop.
- Both feed `HealthService` status via base `Tracker` counters.

## Known Pitfalls

- Chat ID configuration drift in docs can break startup; use `src/config.ts` names.
- This service is stateful (in-memory batch and affected-keys map); always account for flush behavior when changing loops.
- Re-alert logic depends on previous alert records per channel.

## Safe Change Points

- Threshold/routing changes: `src/config.ts`, tracker constructor wiring in `src/index.ts`.
- Message formatting changes: `formatBranchAlert(...)` and related formatter helpers.
- Position classification logic: private helper methods inside this tracker.

## Verification After Changes

- `bun run typecheck`
- Start bot in a controlled env and verify:
  - websocket connects
  - batch flush logs appear
  - `/stats` and tracking commands still work

## Related Docs

- `docs/architecture.md`
- `docs/data-flow.md`
- `docs/configuration.md`
