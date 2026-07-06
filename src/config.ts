import dotenv from 'dotenv';
dotenv.config({ path: './.env', quiet: true });

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function optionalEnv(name: string, fallback: string): string {
    return process.env[name] || fallback;
}

export enum Environment {
    Development = 'development',
    Production = 'production'
}

const ASSETS_PATH = './resources';
const runtimeEnv = optionalEnv('NODE_ENV', 'development') as Environment;

function getRedisConfig() {
    const getMode = () => {
        const mode = optionalEnv('REDIS_MODE', 'standalone').trim().toLowerCase();
        if (mode === 'sentinel') return 'sentinel';
        return 'standalone';
    };

    const parseSentinelHost = (url: string) => {
        const match = url.match(/^redis:\/\/([^:]+):(\d+):(.+)$/);
        if (!match) {
            throw new Error(
                `Invalid REDIS_URL format for sentinel mode. Expected format: redis://sentinelHost:sentinelPort:sentinelName`
            );
        }
        return {
            host: match[1],
            port: parseInt(match[2], 10),
            name: match[3]
        };
    };

    const mode = getMode();
    const url = optionalEnv('REDIS_URL', 'redis://localhost:6379') as string;
    const password = optionalEnv('REDIS_PASSWORD', '') as string;

    if (mode === 'sentinel') {
        const sentinelHost = parseSentinelHost(url);
        return {
            mode,
            sentinel: {
                ...sentinelHost,
                replicaPoolSize: parseInt(optionalEnv('REDIS_SENTINEL_REPLICA_POOL_SIZE', '1'), 10)
            },
            password: password
        };
    }
    return {
        mode,
        url: url,
        password: password
    };
}

function parseCoinglassExchanges(value: string): string[] {
    const EXTERNALLY_MANAGED_OI_EXCHANGES = new Set(['hyperliquid', 'aster']);
    const exchanges = value.split(',').map((e) => e.trim());
    const invalidExchanges = exchanges.filter((exchange) =>
        EXTERNALLY_MANAGED_OI_EXCHANGES.has(exchange.toLowerCase())
    );

    if (invalidExchanges.length > 0) {
        throw new Error(
            `COINGLASS_EXCHANGES cannot include externally managed exchanges: ${invalidExchanges.join(', ')}. ` +
                'Remove them from COINGLASS_EXCHANGES.'
        );
    }

    return exchanges;
}

// Config
export const config = {
    env: runtimeEnv,
    logFileEnabled: optionalEnv('LOG_FILE_ENABLED', 'false') === 'true',
    healthServerPort: parseInt(optionalEnv('HEALTH_SERVER_PORT', '9988'), 10),
    restartOnUnhealthy: optionalEnv('RESTART_ON_UNHEALTHY', 'false') === 'true',
    logLevel: optionalEnv('LOG_LEVEL', 'INFO'),
    trackers: process.env['ENABLED_TRACKERS'] ? process.env['ENABLED_TRACKERS'].split(',').map((t) => t.trim()) : [],
    telegram: {
        botToken: requireEnv('BOT_TOKEN'),
        hlTwapChatID: parseInt(requireEnv('HL_TWAP_CHAT_ID'), 10),
        hlTrackChatID: parseInt(requireEnv('HL_TRACK_CHAT_ID'), 10),
        hlBigWhaleChatID: parseInt(requireEnv('HL_BIG_WHALE_CHAT_ID'), 10),
        hlFreshWalletChatID: parseInt(requireEnv('HL_FRESH_WALLET_CHAT_ID'), 10),
        hlWhaleActivityChatID: parseInt(requireEnv('HL_WHALE_ACTIVITY_CHAT_ID'), 10),
        stakeChatID: parseInt(requireEnv('STAKE_CHAT_ID'), 10),
        oiChatID: parseInt(requireEnv('OI_CHAT_ID'), 10),
        hlOIChatID: parseInt(requireEnv('OI_HL_CHAT_ID'), 10),
        polyChatID: parseInt(requireEnv('POLY_CHAT_ID'), 10),
        ownerUserID: parseInt(requireEnv('OWNER_USER_ID'), 10)
    },
    monitor: {
        cacheTTLMs: 5 * 60 * 1000, // 2 minutes,
        intervalMs: 30 * 1000, // 30 seconds
        cleanupIntervalMs: 60 * 60 * 1000, // 1 hour
        noDataTimeoutMs: 5 * 60 * 1000, // 5 minutes
        scanStallTimeoutMs: 10 * 60 * 1000 // 10 minutes
    },
    hyperliquid: {
        excludeDexes: process.env['HL_EXCLUDE_DEXES']
            ? process.env['HL_EXCLUDE_DEXES'].split(',').map((d) => d.trim())
            : [],
        minNotionalUSD: parseFloat(optionalEnv('HL_MIN_NOTIONAL_USD', '300000')),
        minSpotNotionalUSD: parseFloat(optionalEnv('HL_MIN_SPOT_NOTIONAL_USD', '300000')),
        aggregationWindowMs: parseInt(optionalEnv('HL_AGGREGATION_WINDOW_MS', String(3 * 24 * 60 * 60 * 1000)), 10),
        minimalGrowthPercent: parseFloat(optionalEnv('HL_POS_CHANGE_ALERT_PERCENT', '9')),
        minimalGrowthUSD: parseFloat(optionalEnv('HL_POS_CHANGE_ALERT_USD', '50000')),
        freshMinUSD: parseFloat(optionalEnv('HL_FRESH_MIN_USD', '200000')),
        freshMainCoinMinUSD: parseFloat(optionalEnv('HL_FRESH_MAIN_COIN_MIN_USD', '450000')),
        whaleMinUSD: parseFloat(optionalEnv('HL_WHALE_MIN_USD', '300000')),
        bigWhaleMinUSD: parseFloat(optionalEnv('HL_BIG_WHALE_MIN_USD', '1000000')),
        twapMaxIntervalMs: parseInt(optionalEnv('HL_TWAP_MAX_INTERVAL_MS', String(45 * 1000)), 10),
        twapMaxGapMs: parseInt(optionalEnv('HL_TWAP_MAX_GAP_MS', String(60 * 1000)), 10),
        twapMinFills: parseInt(optionalEnv('HL_TWAP_MIN_FILLS', '5'), 10),
        twapCoinThresholds: {
            BTC: parseFloat(optionalEnv('HL_TWAP_BTC_MIN_USD', '19000000')),
            ETH: parseFloat(optionalEnv('HL_TWAP_ETH_MIN_USD', '8000000')),
            SOL: parseFloat(optionalEnv('HL_TWAP_SOL_MIN_USD', '5000000')),
            XRP: parseFloat(optionalEnv('HL_TWAP_XRP_MIN_USD', '4000000')),
            DOGE: parseFloat(optionalEnv('HL_TWAP_DOGE_MIN_USD', '4000000')),
            HYPE: parseFloat(optionalEnv('HL_TWAP_HYPE_MIN_USD', '5000000')),
            BNB: parseFloat(optionalEnv('HL_TWAP_BNB_MIN_USD', '5000000'))
        } as Record<string, number>,
        freshWindowMs: parseInt(optionalEnv('HL_FRESH_WINDOW_MS', String(50 * 60 * 60 * 1000)), 10),
        screenshotEnabled: optionalEnv('HL_SCREENSHOT_ENABLED', 'true') === 'true',
        mainCoins: ['BTC', 'ETH', 'BNB', 'XRP', 'ZEC', 'DOGE', 'SOL', 'HYPE'] as string[],
        wss: 'wss://api.hyperliquid.xyz/ws',
        api: 'https://api.hyperliquid.xyz/info',
        hypurrscanExplorer: 'https://hypurrscan.io',
        hyperdashExplorer: 'https://hyperdash.com',
        batchSize: 1000,
        minTradeNotionalUSD: 500,
        batchFlushIntervalMs: 60 * 1000, // 1 minute
        cleanupTTLms: 5 * 24 * 60 * 60 * 1000, // 5 days
        trackedCheckIntervalMs: 30 * 60 * 1000, // 30 minutes
        analyzeIntervalMs: 15 * 60 * 1000, // 15 minutes
        retry: {
            maxAttempts: 3,
            initialDelayMs: 1000,
            backoffMultiplier: 2,
            maxDelayMs: 30000
        },
        rateLimit: { requestsPerSecond: 1, burstCapacity: 3 }
    },
    stake: {
        minAlertBetUSD: parseFloat(optionalEnv('STAKE_MIN_BET_USD', '10000')),
        screenshotEnabled: optionalEnv('STAKE_SCREENSHOT_ENABLED', 'true') === 'true',
        url: 'https://stake.com',
        api: 'https://stake.com/_api/graphql',
        wss: 'wss://stake.com/_api/websockets',
        batchSize: 30,
        batchFlushIntervalMs: 30 * 1000, // 30 seconds
        cleanupTTLms: 24 * 60 * 60 * 1000, // 24 hours
        alertAgeMs: 5 * 60 * 1000, // 5 minutes
        retry: {
            maxAttempts: 3,
            initialDelayMs: 1000,
            backoffMultiplier: 2,
            maxDelayMs: 30000
        }
    },
    polymarket: {
        alertThresholdUsd: Number(optionalEnv('POLY_ALERT_THRESHOLD_USD', '100000')),
        sportAlertThresholdUsd: Number(optionalEnv('POLY_SPORT_BET_ALERT_THRESHOLD_USD', '500000')),
        maxPriceFilter: Number(optionalEnv('POLY_MAX_PRICE_FILTER', '0.98')),
        minimalGrowthPercent: parseFloat(optionalEnv('POLY_POS_CHANGE_ALERT_PERCENT', '20')),
        minimalGrowthUSD: parseFloat(optionalEnv('POLY_POS_CHANGE_ALERT_USD', '9000')),
        aggregationWindowMs: parseInt(optionalEnv('POLY_AGGREGATION_WINDOW_MS', String(7 * 24 * 60 * 60 * 1000)), 10),
        screenshotEnabled: optionalEnv('POLY_SCREENSHOT_ENABLED', 'true') === 'true',
        url: 'https://polymarket.com',
        wss: 'wss://ws-live-data.polymarket.com',
        dataApi: 'https://data-api.polymarket.com',
        gammaApi: 'https://gamma-api.polymarket.com',
        dataApiRateLimit: 5,
        gammaApiRateLimit: 2,
        batchSize: 50,
        batchFlushIntervalMs: 10 * 1000, // 30 seconds
        cleanupTTLms: 5 * 24 * 60 * 60 * 1000, // 5 days
        retry: {
            maxAttempts: 3,
            initialDelayMs: 1000,
            backoffMultiplier: 2,
            maxDelayMs: 30000
        },
        gammaRateLimit: { requestsPerSecond: 2 },
        dataRateLimit: { requestsPerSecond: 5 }
    },
    db: {
        mongodbURI: optionalEnv('MONGODB_URI', 'mongodb://root:example@localhost:27017') as string,
        dbName: optionalEnv('DB_NAME', 'whale-tracker-bot') as string,
        autoIndex: true,
        ensureIndexesOnStart: true
    },
    redis: getRedisConfig(),
    puppeteer: {
        userDir: optionalEnv('PUPPETEER_USER_DIR', '') as string,
        headless: optionalEnv('PUPPETEER_HEADLESS', 'true') === 'true',
        concurrentCaptures: optionalEnv('PUPPETEER_CONCURRENT_CAPTURES', 'false') === 'true',
        proxiesPath: optionalEnv('PUPPETEER_PROXIES_PATH', `${ASSETS_PATH}/ports.txt`) as string,
        proxies: optionalEnv('PUPPETEER_PROXIES', '')
            .split(',')
            .map((p) => p.trim())
            .filter((p) => p) as string[]
    },
    openRouter: {
        apiKey: requireEnv('OPENROUTER_API_KEY') as string,
        classifierPromptTemplatePath: optionalEnv(
            'OPENROUTER_CLASSIFIER_PROMPT_TEMPLATE_PATH',
            `${ASSETS_PATH}/trade_classifier_prompt.txt`
        ) as string,
        fastModel: optionalEnv('OPENROUTER_FAST_MODEL', 'gpt-3.5-turbo') as string
    },
    coinglass: {
        apiKey: requireEnv('COINGLASS_API_KEY') as string,
        api: 'https://open-api-v4.coinglass.com',
        retry: {
            maxAttempts: 4,
            initialDelayMs: 1000,
            backoffMultiplier: 2,
            maxDelayMs: 30000
        },
        rateLimit: {
            requestsPerSecond: 1.25,
            headerUsageKey: 'api-key-use-limit',
            headerLimitKey: 'api-key-max-limit',
            throttleThreshold: 0.9
        }
    },
    aster: {
        api: 'https://fapi.asterdex.com',
        retry: {
            maxAttempts: 4,
            initialDelayMs: 1000,
            backoffMultiplier: 2.5,
            maxDelayMs: 30000
        },
        rateLimit: {
            requestsPerSecond: 38,
            burstCapacity: 10,
            headerUsageKey: 'x-mbx-used-weight-1m',
            throttleThreshold: 0.85
        }
    },
    oi: {
        coinglassExchanges: parseCoinglassExchanges(
            process.env['COINGLASS_EXCHANGES'] || 'Gate,Bybit,Binance,OKX,Kraken'
        ),
        sources: optionalEnv('OI_SOURCES', 'coinglass,hyperliquid')
            .split(',')
            .map((s) => s.trim()),
        refreshIntervalMs: parseInt(optionalEnv('COINGLASS_REFRESH_INTERVAL_MS', '3600000'), 10),
        coinglassGapThresholdIntervals: parseInt(optionalEnv('COINGLASS_GAP_THRESHOLD_INTERVALS', '3'), 10),
        screenshotEnabled: optionalEnv('OI_SCREENSHOT_ENABLED', 'true') === 'true',
        cooldownSeconds: 21600, // 6 hours
        warmupCandles: 96, // 48 hours of 30m candles
        ewmaAlpha: 2 / (96 + 1), // ~0.02062
        zScoreThreshold: 4, // fast spike → HIGH
        cumulativeZThreshold: 8, // slow accumulation over 4 candles → HIGH
        cumulativeZWindow: 4, // candles for cumulative z
        cusumThreshold: 12, // sustained build → CRITICAL
        madFloorFraction: 0.0075,
        minOIThreshold: 1_000_000, // minimum OI in USD to consider for detection
        minDeltaOIUsd: 100_000, // minimum OI delta (USD) required for any trigger
        minDeltaOIPercent: 1.5, // minimum OI delta (%) required for any trigger
        cusumDrift: 1, // CUSUM drift parameter k

        coinglassIntervalMs: 5 * 60 * 1000, // 5 minutes
        coinglassScanFetchLimit: 3,
        hlIntervalMs: 15 * 60 * 1000, // 15 minutes
        noDataTimeoutMs: 120 * 60 * 1000, // 2 hour
        scanStallTimeoutMs: 120 * 60 * 1000, // 2 hour
        cleanupTTLms: 3 * 24 * 60 * 60 * 1000 // 3 days
    }
} as const;
