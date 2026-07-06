# Whale Tracker Bot

Telegram bot for monitoring high-value activity across:

- Hyperliquid perp trades
- Polymarket trades
- Stake sports bets
- CoinGlass exchange OI anomalies (statistical detection)

The bot stores data in MongoDB, uses Redis for caching/deduplication, and sends alerts to dedicated Telegram channels (one per alert branch). It also supports manual Hyperliquid wallet tracking commands.

## Features

- Real-time ingestion from WebSocket/API feeds
- 4-branch Hyperliquid alert system:
  - **Fresh Wallet** — new wallets (≤50h) opening positions ≥$200K (excl. BTC/ETH)
  - **Whale Activity** — established wallets with positions ≥$300K (excl. BTC/ETH)
  - **Big Whale** — any position ≥$1M (all coins)
  - **Big TWAP** — perp or spot buy/sell accumulation executed as a burst of same-direction fills (fills ≤60s apart, avg cycle ≤45s, ≥5 fills); per-coin minimums (BTC ≥$19M, ETH ≥$8M, SOL/HYPE/BNB ≥$5M, XRP/DOGE ≥$4M). Only these coins alert; all other trades are still collected for analysis.
- Re-alerts when tracked positions grow +9% from last alert
- Hyperliquid manual tracking commands: `/track`, `/untrack`, `/tracked`, `/stats`
- Polymarket and Stake whale alerts
- CoinGlass OI anomaly detection (EWMA/CUSUM/MAD statistical methods, per-exchange)
- Optional Screenshots via Puppeteer

## Requirements

- Bun (runtime used by scripts)
- MongoDB
- Redis
- Telegram bot token
- Telegram channels/groups where the bot is an administrator
- OpenRouter API key for analysis/classification features
- CoinGlass API key (STARTUP plan, 30m OI history)

## Environment

Create a `.env` file in the project root.

### Required

| Variable | Description |
| --- | --- |
| `BOT_TOKEN` | Telegram bot token |
| `HL_FRESH_WALLET_CHAT_ID` | Channel ID for Fresh Wallet alerts |
| `HL_WHALE_ACTIVITY_CHAT_ID` | Channel ID for Whale Activity alerts |
| `HL_BIG_WHALE_CHAT_ID` | Channel ID for Big Whale alerts |
| `HL_TWAP_CHAT_ID` | Channel ID for TWAP alerts |
| `HL_TRACK_CHAT_ID` | Channel ID for tracked wallet notifications |
| `STAKE_CHAT_ID` | Channel ID for Stake alerts |
| `POLY_CHAT_ID` | Channel ID for Polymarket alerts |
| `OWNER_USER_ID` | Telegram user ID used for owner-level checks and watchdog alerts |
| `OPENROUTER_API_KEY` | OpenRouter API key |
| `COINGLASS_API_KEY` | CoinGlass API key (STARTUP plan) |
| `OI_CHAT_ID` | Channel ID for CoinGlass OI anomaly alerts |
| `OI_HL_CHAT_ID` | Channel ID for Hyperliquid OI anomaly alerts |

### Optional (with defaults)

| Variable | Default | Description |
| --- | --- | --- |
| `NODE_ENV` | `development` | Runtime environment (`development` or `production`) |
| `LOG_LEVEL` | `INFO` | Log verbosity (`INFO`, `WARN`, `ERROR`, `DEBUG`) |
| `LOG_FILE_ENABLED` | `false` | Write logs to `./logs/YYYY-MM-DD.log` |
| `RESTART_ON_UNHEALTHY` | `false` | When `true`, the process exits with code `1` after sending the owner alert on an unhealthy `/healthz` so an orchestrator can restart it. When `false`, the bot only alerts and keeps running. |
| `MONGODB_URI` | `mongodb://root:example@localhost:27017` | MongoDB connection URI |
| `DB_NAME` | `whale-tracker-bot` | Database name (`-dev` suffix is added in development) |
| `DB_AUTO_INDEX` | `true` in development, `false` in production | Enable Mongoose auto-indexing on connect |
| `DB_ENSURE_INDEXES_ON_START` | `true` | Explicitly runs `createIndexes()` for all models at startup |
| `REDIS_MODE` | `standalone` | Redis mode (`standalone` or `sentinel`). |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection URL (for standalone use `redis://host:port`, for sentinel use `redis://sentinelHost:sentinelPort:sentinelName`) |
| `REDIS_PASSWORD` | `` | Redis password |
| `HL_MIN_NOTIONAL_USD` | `250000` | Hyperliquid minimum aggregated notional to consider |
| `HL_AGGREGATION_WINDOW_MS` | `86400000` | Hyperliquid aggregation window |
| `HL_POS_CHANGE_ALERT_PERCENT` | `9` | Re-alert growth threshold (%) |
| `HL_POS_CHANGE_ALERT_USD` | `50000` | Re-alert minimum USD move |
| `HL_FRESH_WINDOW_MS` | `180000000` | Fresh wallet time window (50h) |
| `HL_FRESH_MIN_USD` | `200000` | Fresh wallet min position (other coins) |
| `HL_FRESH_MAIN_COIN_MIN_USD` | `450000` | Fresh wallet min position (main coins) |
| `HL_WHALE_MIN_USD` | `300000` | Whale activity min position |
| `HL_BIG_WHALE_MIN_USD` | `1000000` | Big whale min position |
| `HL_TWAP_MAX_INTERVAL_MS` | `45000` | Max avg interval between TWAP cycles (45s) |
| `HL_TWAP_MAX_GAP_MS` | `60000` | Max gap between consecutive fills in a TWAP burst (60s) |
| `HL_TWAP_MIN_FILLS` | `5` | Min number of fills to qualify as a TWAP burst |
| `HL_TWAP_BTC_MIN_USD` | `19000000` | TWAP min traded notional for BTC |
| `HL_TWAP_ETH_MIN_USD` | `8000000` | TWAP min traded notional for ETH |
| `HL_TWAP_SOL_MIN_USD` | `5000000` | TWAP min traded notional for SOL |
| `HL_TWAP_XRP_MIN_USD` | `4000000` | TWAP min traded notional for XRP |
| `HL_TWAP_DOGE_MIN_USD` | `4000000` | TWAP min traded notional for DOGE |
| `HL_TWAP_HYPE_MIN_USD` | `5000000` | TWAP min traded notional for HYPE |
| `HL_TWAP_BNB_MIN_USD` | `5000000` | TWAP min traded notional for BNB |
| `STAKE_MIN_BET_USD` | `10000` | Stake minimum bet size for alerts |
| `POLY_ALERT_THRESHOLD_USD` | `100000` | Polymarket regular market alert threshold |
| `POLY_SPORT_BET_ALERT_THRESHOLD_USD` | `500000` | Polymarket sport market alert threshold |
| `POLY_MAX_PRICE_FILTER` | `0.98` | Polymarket max price filter |
| `POLY_POS_CHANGE_ALERT_PERCENT` | `20` | Polymarket growing-position percent threshold |
| `POLY_POS_CHANGE_ALERT_USD` | `9000` | Polymarket growing-position minimum USD threshold |
| `HL_SCREENSHOT_ENABLED` | `true` | Include screenshots in Hyperliquid alerts |
| `STAKE_SCREENSHOT_ENABLED` | `true` | Include screenshots in Stake alerts |
| `POLY_SCREENSHOT_ENABLED` | `true` | Include screenshots in Polymarket alerts |
| `OI_SCREENSHOT_ENABLED` | `true` | Include screenshots in OI anomaly alerts |
| `PUPPETEER_USER_DIR` | `` | Puppeteer user data directory |
| `PUPPETEER_HEADLESS` | `true` | Run Puppeteer in headless mode |
| `PUPPETEER_CONCURRENT_CAPTURES` | `false` | Allow trackers to run screenshot captures in parallel. When `false`, captures are serialized through a FIFO queue. |
| `PUPPETEER_PROXIES_PATH` | `./resources/ports.txt` | File with proxies for Puppeteer |
| `PUPPETEER_PROXIES` | `` | Comma-separated proxy list |
| `OPENROUTER_CLASSIFIER_PROMPT_TEMPLATE_PATH` | `./resources/trade_classifier_prompt.txt` | Prompt template path |
| `OPENROUTER_FAST_MODEL` | `gpt-3.5-turbo` | OpenRouter model used for fast classification |
| `COINGLASS_EXCHANGES` | `Gate,Bybit,Binance,OKX,Kraken` | Comma-separated CoinGlass exchanges to monitor. Do not include `Hyperliquid` or `Aster`; they are managed by direct sources. |
| `COINGLASS_REFRESH_INTERVAL_MS` | `3600000` | Token universe refresh interval (1h) |
| `COINGLASS_GAP_THRESHOLD_INTERVALS` | `3` | Missed 30m intervals before a pair enters DEGRADED_DATA |

## Run locally

```bash
bun install
bun run start
```

## Run with Docker Compose

```bash
docker compose up --build
```

This starts MongoDB, Redis, and the bot container.

## Documentation

- Architecture: `docs/architecture.md`
- Data flow: `docs/data-flow.md`
- Tracker deep dives:
  - `docs/components/hyperliquid.md`
  - `docs/components/polymarket.md`
  - `docs/components/stake.md`
  - `docs/components/oi.md`
- Configuration: `docs/configuration.md`
- Operations runbook: `docs/operations.md`

## Telegram commands

- `/stats <coin>`: Show Hyperliquid stats for a coin
- `/tracked`: List manually tracked Hyperliquid positions
- `/track <wallet> <coin> <long|short>`: Add a tracked Hyperliquid position
- `/untrack <wallet> <coin> <long|short>`: Remove a tracked Hyperliquid position

Commands are restricted to the configured channels and require admin/owner permissions.
