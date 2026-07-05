import Logger from './common/logger';
import { connectDB, closeDB } from './services/db';
import {
    HyperliquidService,
    StakeService,
    PolymarketService,
    CoinglassService as OIService,
    trackerNames
} from './services/trackers';
import Tg from './services/telegram';
import { closeRedis, connectRedis } from './services/redis';
import { Tracker } from './common/tracker';
import { config } from './config';
import HealthService from './healthz';
import { registerHyperliquidHandlers, registerOIHandlers } from './handlers';
import { sweepOrphanBrowserDirs } from './common/browser-dir';

const logger = new Logger('Main');
const telegram: Tg = new Tg();
const services: Tracker[] = getEnabledTrackers();
const healthServer = new HealthService(config.healthServerPort, services);

function getEnabledTrackers(): Tracker[] {
    if (config.trackers.length === 0)
        throw new Error('At least one tracker must be enabled via ENABLED_TRACKERS env variable');
    if (config.trackers.some((t) => !trackerNames.map((n) => n.name).includes(t)))
        throw new Error(
            `Invalid tracker name in ENABLED_TRACKERS. Valid options: ${[...trackerNames.map((n) => n.name)].join(', ')}`
        );

    const services: Tracker[] = [];

    for (const trackerConfig of trackerNames) {
        if (config.trackers.includes(trackerConfig.name)) {
            logger.info(`Enabling tracker: ${trackerConfig.fullName}`);
            switch (trackerConfig.fullName) {
                case HyperliquidService.name:
                    services.push(
                        new HyperliquidService(
                            telegram,
                            [{ chatId: config.telegram.hlFreshWalletChatID }],
                            [{ chatId: config.telegram.hlWhaleActivityChatID }],
                            [{ chatId: config.telegram.hlBigWhaleChatID }],
                            [{ chatId: config.telegram.hlTwapChatID }],
                            [{ chatId: config.telegram.hlTrackChatID }],
                            config.hyperliquid.screenshotEnabled
                        )
                    );
                    break;
                case StakeService.name:
                    services.push(
                        new StakeService(
                            telegram,
                            [{ chatId: config.telegram.stakeChatID }],
                            config.stake.screenshotEnabled,
                            false
                        )
                    );
                    break;
                case PolymarketService.name:
                    services.push(
                        new PolymarketService(
                            telegram,
                            [{ chatId: config.telegram.polyChatID }, { chatId: -1003468238602, topicId: 10961 }],
                            config.polymarket.screenshotEnabled
                        )
                    );
                    break;
                case OIService.name:
                    if (OIService.validateSources(config.oi.sources)) {
                        services.push(
                            new OIService(
                                telegram,
                                config.oi.sources,
                                [{ chatId: config.telegram.oiChatID }],
                                [{ chatId: config.telegram.hlOIChatID }],
                                config.oi.screenshotEnabled
                            )
                        );
                    } else {
                        throw new Error(
                            `Invalid OI_SOURCES value: ${config.oi.sources}. Valid options: ${OIService.getValidSources().join(', ')}`
                        );
                    }
                    break;
                default:
                    logger.warn(`Unknown tracker name: ${trackerConfig.fullName}`);
            }
        }
    }
    return services;
}

telegram.registerHandlers((tg) => {
    const hl = services.find((s) => s instanceof HyperliquidService) as HyperliquidService | undefined;
    if (hl) {
        registerHyperliquidHandlers(tg, hl);
    } else {
        logger.warn('HyperliquidService is not enabled, /track and /untrack commands will be unavailable');
    }

    const oi = services.find((s) => s instanceof OIService) as OIService | undefined;
    if (oi) {
        registerOIHandlers(tg, oi);
    } else {
        logger.warn('OIService is not enabled, OI-related commands will be unavailable');
    }
});

function startMonitoringServices(): void {
    for (const service of services) {
        logger.info(`Auto-starting service: ${service.constructor.name}`);
        void service.start();
    }
}

async function stopMonitoringServices(): Promise<void> {
    await Promise.allSettled(
        services.map((service) => {
            logger.info(`Stopping service: ${service.constructor.name}`);
            return service.stop();
        })
    );
}

async function shutdown(code: number): Promise<void> {
    logger.info('Shutting down...');
    try {
        healthServer.stop();
        telegram.stop();
        await Promise.allSettled([stopMonitoringServices(), closeDB(), closeRedis()]);
    } catch (error) {
        logger.error(`Error during shutdown: ${error}`);
    }
    logger.info('Shutdown complete.');
    process.exit(code);
}

async function main(): Promise<void> {
    await sweepOrphanBrowserDirs();
    await connectDB();
    await connectRedis();
    void telegram.start(
        () => {
            logger.info('Telegram bot started successfully.');
        },
        (err) => {
            logger.error(`Telegram bot error: ${err}`);
            shutdown(1);
        }
    );

    logger.info('Starting monitoring services...');
    startMonitoringServices();
    healthServer.start(async (error?: string) => {
        telegram
            .sendRestartUnhealthyAlert(error)
            .catch((err) => logger.error(`Failed to send unhealthy alert: ${err}`));
        if (config.restartOnUnhealthy) {
            logger.info('Restarting services due to unhealthy status...');
            shutdown(1);
        }
    });

    process.once('SIGINT', () => void shutdown(0));
    process.once('SIGTERM', () => void shutdown(0));
}

main().catch((error) => {
    logger.error(`Fatal error during startup: ${error}`);
    shutdown(1);
});
