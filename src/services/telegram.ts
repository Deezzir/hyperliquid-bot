import { Context, Telegraf } from 'telegraf';
import { config } from '../config';
import Logger from '../common/logger';
import { InlineKeyboardMarkup, InputFile } from 'telegraf/types';
import { getRedisClient } from './redis';
import { HyperliquidService, StakeService, PolymarketService, CoinglassService, trackerNames } from './trackers';
import { retry } from '../common/utils';

const logger = new Logger('Telegram');

interface SendMessageOptions {
    reply_markup?: InlineKeyboardMarkup;
    message_thread_id?: number;
}

export default class TelegramService {
    private bot: Telegraf;
    private handlerRegistrar?: (tg: TelegramService) => void;
    private allChatIDs: number[];

    constructor() {
        this.bot = new Telegraf(config.telegram.botToken);
        this.allChatIDs = Object.entries(config.telegram)
            .filter(([key, value]) => key.toLowerCase().endsWith('chatid') && typeof value === 'number')
            .map(([, value]) => value as number);
    }

    public registerHandlers(fn: (tg: TelegramService) => void): void {
        this.handlerRegistrar = fn;
    }

    public async start(startCallback: () => void, errorCallback: (err: any) => void): Promise<void> {
        if (!this.handlerRegistrar) {
            throw new Error('Handlers must be registered via registerHandlers() before starting TelegramService.');
        }
        this.registerInternalHandlers();
        this.handlerRegistrar(this);
        await this.ensureBotReady();
        await this.bot.launch(() => {
            startCallback();
            this.sendStartupMessage().catch((err) => logger.error(`Failed to send startup message: ${err}`));
        });
        this.bot.catch(errorCallback);
    }

    public stop(): void {
        try {
            this.bot.stop();
        } catch (err) {
            logger.error(`Failed to stop Telegram bot: ${err}`);
        }
    }

    public getBot(): Telegraf {
        return this.bot;
    }

    private registerInternalHandlers(): void {
        this.bot.on('message', async (ctx, next) => {
            const msg = ctx.message;
            // @ts-ignore
            if (msg && msg.pinned_message) {
                try {
                    await ctx.deleteMessage(msg.message_id);
                } catch (err) {
                    logger.warn(`Failed to delete pin service message: ${err}`);
                }
            }
            return next();
        });
    }

    private async sendStartupMessage(): Promise<void> {
        const STARTUP_MSG_PREFIX = 'bot:startup_message_id:';
        const redis = getRedisClient();
        const fmt = (n: number) => `$${n.toLocaleString('en-US')}`;
        const fmtH = (ms: number) => `${Math.round(ms / (60 * 60 * 1000))}h`;

        const channelMessages: { chatId: number; message: string; tracker: string }[] = [
            {
                tracker: HyperliquidService.name,
                chatId: config.telegram.hlFreshWalletChatID,
                message: [
                    `<b>🟢 Fresh Wallet Channel</b>`,
                    ``,
                    `🆕 Threshold: <b>${fmt(config.hyperliquid.freshMinUSD)}</b>`,
                    `🪙 Main coins (BNB, XRP, DOGE, SOL, ZEC, HYPE): <b>${fmt(config.hyperliquid.freshMainCoinMinUSD)}</b>`,
                    `⏱ Fresh window: <b>${fmtH(config.hyperliquid.freshWindowMs)}</b>`,
                    `📈 Re-alert: <b>+${config.hyperliquid.minimalGrowthPercent}%</b>`,
                    `🚫 Excluded: BTC, ETH`
                ].join('\n')
            },
            {
                tracker: HyperliquidService.name,
                chatId: config.telegram.hlWhaleActivityChatID,
                message: [
                    `<b>🟢 Whale Activity Channel</b>`,
                    ``,
                    `🐋 Threshold: <b>${fmt(config.hyperliquid.whaleMinUSD)}</b>`,
                    `📈 Re-alert: <b>+${config.hyperliquid.minimalGrowthPercent}%</b>`,
                    `🚫 Excluded: BTC, ETH`
                ].join('\n')
            },
            {
                tracker: HyperliquidService.name,
                chatId: config.telegram.hlBigWhaleChatID,
                message: [
                    `<b>🟢 Big Whale Channel</b>`,
                    ``,
                    `🚨 Threshold: <b>${fmt(config.hyperliquid.bigWhaleMinUSD)}</b>`,
                    `📈 Re-alert: <b>+${config.hyperliquid.minimalGrowthPercent}%</b>`,
                    `🪙 All coins`
                ].join('\n')
            },
            {
                tracker: HyperliquidService.name,
                chatId: config.telegram.hlTwapChatID,
                message: [
                    `<b>🟢 TWAP Channel</b>`,
                    ``,
                    `⏱ Window: <b>3h</b> · Interval: <b>≤45s</b>`,
                    `🔄 BTC: <b>${fmt(config.hyperliquid.twapCoinThresholds.BTC)}</b>`,
                    `🔄 ETH: <b>${fmt(config.hyperliquid.twapCoinThresholds.ETH)}</b>`,
                    `🔄 SOL: <b>${fmt(config.hyperliquid.twapCoinThresholds.SOL)}</b>`,
                    `🔄 XRP: <b>${fmt(config.hyperliquid.twapCoinThresholds.XRP)}</b>`,
                    `🔄 DOGE: <b>${fmt(config.hyperliquid.twapCoinThresholds.DOGE)}</b>`,
                    `🔄 HYPE: <b>${fmt(config.hyperliquid.twapCoinThresholds.HYPE)}</b>`,
                    `🔄 BNB: <b>${fmt(config.hyperliquid.twapCoinThresholds.BNB)}</b>`,
                    `📈 Re-alert: <b>+${config.hyperliquid.minimalGrowthPercent}%</b>`,
                    `📋 Min trades: 5`
                ].join('\n')
            },
            {
                tracker: StakeService.name,
                chatId: config.telegram.stakeChatID,
                message: [`<b>🟢 Stake Channel</b>`, ``, `🎰 Min bet: <b>${fmt(config.stake.minAlertBetUSD)}</b>`].join(
                    '\n'
                )
            },
            {
                tracker: PolymarketService.name,
                chatId: config.telegram.polyChatID,
                message: [
                    `<b>🟢 Polymarket Channel</b>`,
                    ``,
                    `🎰 Regular: <b>${fmt(config.polymarket.alertThresholdUsd)}</b>`,
                    `⚽ Sport: <b>${fmt(config.polymarket.sportAlertThresholdUsd)}</b>`,
                    `📈 Re-alert: <b>+${config.polymarket.minimalGrowthPercent}%</b>`
                ].join('\n')
            },
            {
                tracker: CoinglassService.name,
                chatId: config.telegram.oiChatID,
                message: [
                    `<b>🟢 CoinGlass OI Anomaly Channel</b>`,
                    ``,
                    `📊 Exchanges: <b>${config.oi.coinglassExchanges.join(', ')}</b>`,
                    `⚡ Fast Spike: z > <b>${config.oi.zScoreThreshold}</b>`,
                    `📈 Slow Accumulation: Σz > <b>${config.oi.cumulativeZThreshold}</b> (${config.oi.cumulativeZWindow} candles)`,
                    `🔥 Sustained Build: CUSUM > <b>${config.oi.cusumThreshold}</b>`,
                    `⏱ Cooldown: <b>${config.oi.cooldownSeconds / 3600}h</b>`,
                    `🕐 Coinglass Scan interval: <b>${config.oi.coinglassIntervalMs / 60000}m</b>`
                ].join('\n')
            },
            {
                tracker: CoinglassService.name,
                chatId: config.telegram.hlOIChatID,
                message: [
                    `<b>🟢 Hyperliquid OI Anomaly Channel</b>`,
                    ``,
                    `⚡ Fast Spike: z > <b>${config.oi.zScoreThreshold}</b>`,
                    `📈 Slow Accumulation: Σz > <b>${config.oi.cumulativeZThreshold}</b> (${config.oi.cumulativeZWindow} candles)`,
                    `🔥 Sustained Build: CUSUM > <b>${config.oi.cusumThreshold}</b>`,
                    `⏱ Cooldown: <b>${config.oi.cooldownSeconds / 3600}h</b>`,
                    `🕐 Hyperliquid Scan interval: <b>${config.oi.hlIntervalMs / 60000}m</b>`
                ].join('\n')
            }
        ];

        const enabledMessages = channelMessages.filter(({ tracker }) =>
            trackerNames
                .filter((t) => config.trackers.includes(t.name))
                .map((t) => t.fullName)
                .includes(tracker)
        );
        logger.info(`Sending startup messages to ${enabledMessages.length} channels`);
        for (const { chatId, message } of enabledMessages) {
            const redisKey = `${STARTUP_MSG_PREFIX}${chatId}`;
            const oldMsgId = await redis.get(redisKey);
            if (oldMsgId) {
                try {
                    await this.bot.telegram.unpinChatMessage(chatId, Number(oldMsgId));
                    await this.bot.telegram.deleteMessage(chatId, Number(oldMsgId));
                } catch (err) {
                    logger.warn(`Failed to delete old startup message in ${chatId} (id=${oldMsgId}): ${err}`);
                }
            }

            const msgId = await this.sendMessage(chatId, message);
            await this.bot.telegram.pinChatMessage(chatId, msgId, { disable_notification: true });
            await redis.set(redisKey, msgId);
        }

        logger.info('Startup messages sent and pinned to all channels');
    }

    public async sendRestartUnhealthyAlert(error?: string): Promise<void> {
        let message = `<b>🛑 Some services are unhealthy.</b>`;
        if (error) message += `\n\n${error}`;
        if (config.restartOnUnhealthy) message += `\n\nThe bot will attempt to restart.`;
        await this.sendMessage(config.telegram.ownerUserID, message);
    }

    public async sendNoDataAlert(trackerName: string, timeoutMs: number, attempt: number): Promise<void> {
        this.sendMessage(
            config.telegram.ownerUserID,
            `⚠️ Alert: No data received for ${Math.floor(timeoutMs / 60000)} minutes from ${trackerName}. Attempt ${attempt}.`
        ).catch((err) => logger.error(`Failed to send no data alert: ${err}`));
    }

    public async sendNoScanAlert(trackerName: string, timeoutMs: number, attempt: number): Promise<void> {
        await this.sendMessage(
            config.telegram.ownerUserID,
            `⚠️ Alert: No scan completed for ${Math.floor(timeoutMs / 60000)} minutes from ${trackerName}. Attempt ${attempt}.`
        ).catch((err) => logger.error(`Failed to send no scan alert: ${err}`));
    }

    public async sendMessage(chatID: number, message: string, extra?: SendMessageOptions): Promise<number> {
        const MAX_RETRIES = 3;
        return retry(
            async () => {
                const msg = await this.bot.telegram.sendMessage(chatID, message, {
                    parse_mode: 'HTML',
                    link_preview_options: { is_disabled: true },
                    reply_markup: extra?.reply_markup,
                    message_thread_id: extra?.message_thread_id
                });
                return msg.message_id;
            },
            { attempts: MAX_RETRIES },
            logger
        );
    }

    public async sendPhoto(
        chatID: number,
        photo: Buffer,
        caption: string,
        extra?: SendMessageOptions
    ): Promise<number> {
        const MAX_RETRIES = 3;
        const TELEGRAM_CAPTION_LIMIT = 1024;
        const oversized = caption.length > TELEGRAM_CAPTION_LIMIT;

        const photoMessageId = await retry(
            async () => {
                const inputFile: InputFile = {
                    source: photo,
                    filename: `photo_${Date.now()}.jpg`
                };
                const msg = await this.bot.telegram.sendPhoto(chatID, inputFile, {
                    caption: oversized ? undefined : caption,
                    parse_mode: oversized ? undefined : 'HTML',
                    reply_markup: oversized ? undefined : extra?.reply_markup,
                    message_thread_id: extra?.message_thread_id
                });
                return msg.message_id;
            },
            { attempts: MAX_RETRIES },
            logger
        );

        if (oversized) {
            await this.sendReply(chatID, caption, photoMessageId, {
                reply_markup: extra?.reply_markup,
                message_thread_id: extra?.message_thread_id
            });
        }

        return photoMessageId;
    }

    public async sendReply(
        chatID: number,
        text: string,
        replyToMessageId: number,
        extras?: SendMessageOptions
    ): Promise<void> {
        const MAX_RETRIES = 3;
        await retry(
            async () => {
                await this.bot.telegram.sendMessage(chatID, text, {
                    parse_mode: 'HTML',
                    link_preview_options: { is_disabled: true },
                    reply_parameters: { message_id: replyToMessageId },
                    message_thread_id: extras?.message_thread_id,
                    reply_markup: extras?.reply_markup
                });
            },
            { attempts: MAX_RETRIES },
            logger
        );
    }

    public async checkMessageSource(ctx: Context, chatID: number | number[], requireOwner: boolean): Promise<boolean> {
        if (!ctx.chat || !ctx.from) {
            await ctx.reply('Unable to determine chat or user information.');
            return false;
        }
        if (ctx.chat.type === 'private') {
            await ctx.reply('The bot is only available in the group.');
            return false;
        }
        const allowedChatIDs = Array.isArray(chatID) ? chatID : [chatID];
        if (!allowedChatIDs.includes(ctx.chat.id)) {
            await ctx.reply('This command can only be used in the target groups.');
            return false;
        }
        const member = await this.bot.telegram.getChatMember(ctx.chat.id, ctx.from.id);
        if (member.status !== 'administrator' && member.status !== 'creator') {
            if (!config.telegram.ownerUserID || ctx.from.id !== config.telegram.ownerUserID) {
                await ctx.reply('Only group administrators can control this.');
                return false;
            }
        }
        if (requireOwner && ctx.from.id !== config.telegram.ownerUserID) {
            await ctx.reply('Only the bot owner can control this.');
            return false;
        }
        return true;
    }

    private async ensureBotReady(): Promise<void> {
        const botInfo = await this.bot.telegram.getMe();

        for (const chatID of this.allChatIDs) {
            const member = await this.bot.telegram.getChatMember(chatID, botInfo.id);
            if (member.status !== 'administrator' && member.status !== 'creator') {
                throw new Error(`The bot is not an administrator in chat ${chatID}`);
            }
        }
    }
}
