import { config } from '../../config';
import { Markup } from 'telegraf';
import { InlineKeyboardMarkup } from 'telegraf/types';
import { ChatChannel, Tracker } from '../../common/tracker';
import { computeBackoffDelayMs, escapeHtml, formatCurrency, formatTimeAgo, sleep } from '../../common/utils';
import Tg from '../telegram';
import DBService, {
    HyperAggregationRecord,
    HyperTrackedRecord,
    HyperTradeDirection,
    HyperTradeRecord,
    PositionKey,
    TradeSnapshot,
    isSpotDirection
} from '../db/hyperliquid';
import APIService, { AssetPosition, PortfolioResponse as TraderPortfolio, TraderState } from '../api/hyperliquid';

type AccountTag = {
    tag: 'FRESH' | 'DORMANT' | 'SMALL' | 'MEDIUM' | 'LARGE';
    totalValue: number;
    perpsValue: number;
    spotValue: number;
    perpsCount: number;
    spotCount: number;
};

function getPortfolioTimestamps(portfolio: TraderPortfolio): { first: number | null; last: number | null } {
    const buckets = portfolio.filter(([label]) => label === 'perpAllTime' || label === 'allTime');
    for (const [, stats] of buckets) {
        const history = stats?.accountValueHistory ?? [];
        if (history.length > 2) {
            return { first: history[0][0], last: history[history.length - 1][0] };
        }
    }
    return { first: null, last: null };
}

function classifyAccountTag(account: TraderState, portfolio: TraderPortfolio): AccountTag {
    if (!account.perp || !account.spot)
        return { tag: 'FRESH', totalValue: 0, perpsValue: 0, spotValue: 0, perpsCount: 0, spotCount: 0 };
    const now = Date.now();
    const { first: firstTimestamp, last: lastTimestamp } = getPortfolioTimestamps(portfolio);

    const perpsValue = parseFloat(account.perp.marginSummary?.accountValue || '0');
    const perpsCount = account.perp.assetPositions ? account.perp.assetPositions.length : 0;

    const spotValue = account.spot.balances.reduce((sum, b) => sum + parseFloat(b.px) * parseFloat(b.total), 0);
    const spotCount = account.spot.balances ? account.spot.balances.filter((s) => parseFloat(s.hold) !== 0).length : 0;

    const totalValue = perpsValue + spotValue;

    if (firstTimestamp !== null && now - firstTimestamp < config.hyperliquid.freshWindowMs)
        return { tag: 'FRESH', totalValue: totalValue, perpsValue, spotValue, perpsCount, spotCount };
    if (lastTimestamp !== null && now - lastTimestamp > 10 * 24 * 60 * 60 * 1000)
        return { tag: 'DORMANT', totalValue: totalValue, perpsValue, spotValue, perpsCount, spotCount };

    if (totalValue < 500_000)
        return { tag: 'SMALL', totalValue: totalValue, perpsValue, spotValue, perpsCount, spotCount };
    if (totalValue <= 1_000_000)
        return { tag: 'MEDIUM', totalValue: totalValue, perpsValue, spotValue, perpsCount, spotCount };

    return { tag: 'LARGE', totalValue: totalValue, perpsValue, spotValue, perpsCount, spotCount };
}

export type AlertBranch = 'FRESH_WALLET' | 'WHALE_ACTIVITY' | 'BIG_WHALE' | 'BIG_TWAP';

export function classifyBranches(coin: string, totalNotional: number, accountTag: AccountTag): AlertBranch[] {
    const branches: AlertBranch[] = [];
    const cfg = config.hyperliquid;
    const coinUpper = coin.toUpperCase().split('/')[0];
    const isBtcEth = coinUpper === 'BTC' || coinUpper === 'ETH';

    if (totalNotional >= cfg.bigWhaleMinUSD) {
        branches.push('BIG_WHALE');
    }

    if (!isBtcEth && accountTag.tag === 'FRESH') {
        let threshold = cfg.freshMinUSD;
        if (cfg.mainCoins.some((c) => c.toUpperCase() === coinUpper)) {
            threshold = cfg.freshMainCoinMinUSD;
        }
        if (totalNotional >= threshold) {
            branches.push('FRESH_WALLET');
        }
    }

    if (!isBtcEth && accountTag.tag !== 'FRESH' && totalNotional >= cfg.whaleMinUSD) {
        branches.push('WHALE_ACTIVITY');
    }

    return branches;
}

function getTopPositions(assetPositions: AssetPosition[], excludeCoin: string, limit: number): AssetPosition[] {
    return assetPositions
        .filter((pos) => pos.position?.coin !== excludeCoin && pos.position?.szi !== '0')
        .map((pos) => ({
            ...pos,
            _notional: Math.abs(parseFloat(pos.position!.szi) * parseFloat(pos.position!.entryPx || '0'))
        }))
        .sort((a, b) => b._notional - a._notional)
        .slice(0, limit)
        .map(({ _notional, ...pos }) => pos as AssetPosition);
}

interface WsTrade {
    coin: string;
    side: string;
    px: string;
    sz: string;
    hash: string;
    time: number;
    tid: number;
    users: [string, string];
}

function isSpotSellDirection(direction: HyperTradeDirection): boolean {
    return direction === 'spot_sell';
}

function normalizeSpotTicker(symbol: string): string {
    const upper = symbol.toUpperCase();
    if (upper.startsWith('U') && config.hyperliquid.twapCoinThresholds[upper.slice(1)] !== undefined) {
        return upper.slice(1);
    }
    return upper;
}

interface AlertContext {
    candidate: HyperAggregationRecord;
    state: TraderState;
    portfolio: TraderPortfolio;
}

interface SocketSlot {
    ws: WebSocket | null;
    coins: string[];
    pingInterval: NodeJS.Timeout | null;
    reconnecting: boolean;
    reconnectAttempts: number;
}

export default class HyperliquidService extends Tracker {
    private api = new APIService();
    private hypurrscanExplorer = config.hyperliquid.hypurrscanExplorer;
    private hyperdashExplorer = config.hyperliquid.hyperdashExplorer;
    private freshWalletChannels: ChatChannel[];
    private whaleActivityChannels: ChatChannel[];
    private bigWhaleChannels: ChatChannel[];
    private twapChannels: ChatChannel[];
    private trackChannels: ChatChannel[];
    private sockets: SocketSlot[] = [];
    private tradeBatch: HyperTradeRecord[] = [];
    private batchInterval?: NodeJS.Timeout;
    private affectedKeys = new Map<string, PositionKey>();
    private spotCoinMap = new Map<string, string>();

    constructor(
        tg: Tg,
        freshWalletChannels: ChatChannel[],
        whaleActivityChannels: ChatChannel[],
        bigWhaleChannels: ChatChannel[],
        twapChannels: ChatChannel[],
        trackChannels: ChatChannel[],
        screenshotEnabled = false
    ) {
        super(tg, []);
        this.bigWhaleChannels = bigWhaleChannels;
        this.freshWalletChannels = freshWalletChannels;
        this.whaleActivityChannels = whaleActivityChannels;
        this.twapChannels = twapChannels;
        this.trackChannels = trackChannels;
        this.screenshotEnabled = screenshotEnabled;
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.logger.info('Monitoring started');

        const perpNames = await this.api.fetchCoins(config.hyperliquid.excludeDexes);
        if (perpNames.length === 0) throw new Error('Failed to fetch coin list from Hyperliquid API');

        const spotPairs = await this.api.fetchSpotCoins();
        if (spotPairs.length === 0) throw new Error('Failed to fetch spot coin list from Hyperliquid API');
        this.spotCoinMap = new Map(spotPairs.map((p) => [p.wsName, p.displayName]));
        this.logger.info(`Loaded ${spotPairs.length} spot pairs for monitoring`);

        this.sockets = this.buildSocketGroups(
            perpNames,
            spotPairs.map((p) => p.wsName)
        ).map((group) => ({
            ws: null,
            coins: group,
            pingInterval: null,
            reconnecting: false,
            reconnectAttempts: 0
        }));
        for (const slot of this.sockets) slot.ws = this.connectWebSocket(slot);

        this.batchInterval = setInterval(() => {
            this.flushTradeBatch().catch((error) => this.logger.error(`Error flushing trade batch: ${error}`));
        }, config.hyperliquid.batchFlushIntervalMs);

        this.monitorTask = this.mainLoop();
    }

    async stop(): Promise<void> {
        if (this.running) {
            this.running = false;
            await this.monitorTask?.catch((error) => this.logger.error(`Error while awaiting monitor task: ${error}`));
            this.monitorTask = undefined;
            this.logger.info('Monitoring stopped');
        }

        this.affectedKeys.clear();
        this.spotCoinMap.clear();
        if (this.batchInterval) {
            clearInterval(this.batchInterval);
            this.batchInterval = undefined;
        }

        await this.flushTradeBatch().catch((error) =>
            this.logger.error(`Error flushing trade batch during stop: ${error}`)
        );
        this.tradeBatch = [];

        for (const slot of this.sockets) {
            if (slot.pingInterval) {
                clearInterval(slot.pingInterval);
                slot.pingInterval = null;
            }
            if (slot.ws) {
                slot.ws.onclose = null;
                slot.ws.onerror = null;
                slot.ws.close();
                slot.ws = null;
            }
        }
        this.sockets = [];

        await this.screenshoter.stop();
    }

    async track(wallet: string, coin: string, direction: HyperTradeDirection): Promise<string> {
        try {
            const found = await DBService.isWalletTracked(wallet, coin, direction);
            if (found)
                return `Wallet <code>${escapeHtml(wallet)}</code> is already being tracked for ${coin.toUpperCase()} ${direction.toUpperCase()}.`;

            const state = await this.api.fetchTraderState(wallet);
            if (!state.perp || !state.spot) {
                this.logger.info(`Unable to fetch state for a wallet ${wallet}`);
                return 'Failed to fetch trader state. Please ensure the wallet address is correct.';
            }

            const currentPosition = state.perp.assetPositions?.find((pos) => pos.position?.coin === coin);
            if (!currentPosition || !currentPosition.position)
                return `No open position found for wallet <code>${escapeHtml(wallet)}</code> on coin <code>$${coin.toUpperCase()}</code>.`;

            const currentSzi = parseFloat(currentPosition.position.szi || '0');
            const currentDirection: HyperTradeDirection = currentSzi > 0 ? 'long' : 'short';
            if (currentDirection !== direction)
                return (
                    `The current position direction for wallet <code>${escapeHtml(wallet)}</code> on coin <code>$${coin.toUpperCase()}</code> is <b>${currentDirection.toUpperCase()}</b>` +
                    `which does not match the requested tracking direction <b>${direction.toUpperCase()}</b>.`
                );
            const currentNotional = Math.abs(currentSzi) * parseFloat(currentPosition.position.entryPx || '0');

            await DBService.addUpdateTrackedWallet(wallet, coin, direction, currentNotional);
            return `Added wallet <code>${escapeHtml(wallet)}</code> for tracking (${coin.toUpperCase()} ${direction.toUpperCase()}).`;
        } catch (error) {
            this.logger.error(`Failed to track the wallet: ${error}`);
            return 'An error occurred while adding the tracked wallet. Please try again later.';
        }
    }

    async trackById(id: string): Promise<{ msg: string; buttons: InlineKeyboardMarkup | null }> {
        try {
            const trade = await DBService.getTradeById(id);
            if (!trade) return { msg: 'Trade not found.', buttons: null };
            const updated_buttons: InlineKeyboardMarkup = {
                inline_keyboard: [
                    [
                        {
                            text: '🔗 View on Hypurrscan',
                            url: `${this.hypurrscanExplorer}/address/${encodeURIComponent(trade.wallet)}`
                        }
                    ]
                ]
            };

            const found = await DBService.isWalletTracked(trade.wallet, trade.coin, trade.direction);
            if (found)
                return {
                    msg: `Wallet <code>${escapeHtml(trade.wallet)}</code> is already being tracked for ${trade.coin.toUpperCase()} ${trade.direction.toUpperCase()}.`,
                    buttons: updated_buttons
                };
            await DBService.addUpdateTrackedWallet(trade.wallet, trade.coin, trade.direction, trade.totalNotional);
            return {
                msg: `Added wallet <code>${escapeHtml(trade.wallet)}</code> for tracking (${trade.coin.toUpperCase()} ${trade.direction.toUpperCase()}).`,
                buttons: updated_buttons
            };
        } catch (error) {
            this.logger.error(`Failed to track by id: ${error}`);
            return { msg: 'An error occurred while adding the tracked wallet. Please try again later.', buttons: null };
        }
    }

    async untrack(wallet: string, coin: string, direction: HyperTradeDirection): Promise<string> {
        try {
            const deleted = await DBService.removeTrackedWallet(wallet, coin, direction);
            if (deleted) return `Removed wallet <code>${escapeHtml(deleted.wallet)}</code> from tracking.`;
            else return `Wallet <code>${escapeHtml(wallet)}</code> with such order was not found in tracked list.`;
        } catch (error) {
            this.logger.error(`Failed to untrack the wallet ${error}`);
            return 'An error occurred while removing the tracked wallet. Please try again later.';
        }
    }

    async untrackById(id: string): Promise<{ msg: string; buttons: InlineKeyboardMarkup | null }> {
        try {
            const deleted = await DBService.removeTrackedWalletById(id);
            if (deleted) {
                const updated_buttons: InlineKeyboardMarkup = {
                    inline_keyboard: [
                        [
                            {
                                text: '🔗 View on Hypurrscan',
                                url: `${this.hypurrscanExplorer}/address/${encodeURIComponent(deleted.wallet)}`
                            }
                        ]
                    ]
                };
                return {
                    msg: `Removed wallet <code>${escapeHtml(deleted.wallet)}</code> from tracking.`,
                    buttons: updated_buttons
                };
            }
            return { msg: `Wallet with such order was not found in tracked list.`, buttons: null };
        } catch (error) {
            this.logger.error(`Failed to untrack by id: ${error}`);
            return {
                msg: 'An error occurred while removing the tracked wallet. Please try again later.',
                buttons: null
            };
        }
    }

    async listTracked(): Promise<string> {
        try {
            const trackedWallets = await DBService.getTrackedWallets();
            if (trackedWallets.length === 0) {
                return 'No wallets are currently being tracked.';
            }
            const lines = ['📋 <b>Tracked Wallets:</b>', ''];
            for (const tracked of trackedWallets) {
                const compressedWallet = `${tracked.wallet.slice(0, 6)}...${tracked.wallet.slice(-4)}`;
                const directionIcon = tracked.direction === 'long' ? '🟢' : '🔴';
                const href = `${this.hypurrscanExplorer}/address/${encodeURIComponent(tracked.wallet)}`;
                lines.push(`<b>Wallet</b> <a href="${href}">${escapeHtml(compressedWallet)}</a>`);
                lines.push(`<b>Coin:</b> ${directionIcon} <code>${tracked.coin.toUpperCase()}</code>`);
                lines.push(`<b>Size:</b> <code>$${tracked.totalNotional.toLocaleString()}</code>`);
                lines.push('');
            }
            return lines.join('\n');
        } catch (error) {
            this.logger.error(`Failed to list the tracked wallets${error}`);
            return 'An error occurred while listing tracked wallets. Please try again later.';
        }
    }

    private async mainLoop(): Promise<void> {
        const scanLoop = async () => {
            while (this.running) {
                try {
                    await this.scanAndAlert();
                } catch (error) {
                    this.logger.error(`Failed to alert: ${error}`);
                }
                if (!this.running) break;
                await this.cancellableSleep(config.monitor.intervalMs);
            }
        };

        const cleanupLoop = async () => {
            while (this.running) {
                try {
                    await DBService.cleanTrades(config.hyperliquid.cleanupTTLms);
                    await DBService.cleanAlerts(config.hyperliquid.cleanupTTLms);
                } catch (error) {
                    this.logger.error(`Failed to cleanup: ${error}`);
                }
                if (!this.running) break;
                await this.cancellableSleep(config.monitor.cleanupIntervalMs);
            }
        };

        const trackLoop = async () => {
            while (this.running) {
                try {
                    await this.trackAndAlert();
                } catch (error) {
                    this.logger.error(`Failed to track:${error}`);
                }
                if (!this.running) break;
                await this.cancellableSleep(config.hyperliquid.trackedCheckIntervalMs);
            }
        };

        const alertNoDataLoop = this.watchDog(config.monitor.noDataTimeoutMs, async () => {
            this.logger.warn('Forcing WebSocket reconnection due to no data received.');
            for (const slot of this.sockets) this.reconnectWebSocket(slot);
        });

        const scanWatchDog = this.scanWatchDog(config.monitor.scanStallTimeoutMs);

        await Promise.all([scanLoop(), cleanupLoop(), trackLoop(), alertNoDataLoop, scanWatchDog]);
    }

    private async scanAndAlert(): Promise<void> {
        if (this.affectedKeys.size === 0) {
            this.logger.info('No affected positions to scan');
            this.lastScanTimestamp = Date.now();
            return;
        }

        const keysToScan = Array.from(this.affectedKeys.values());
        this.affectedKeys.clear();

        const perpKeys = keysToScan.filter((k) => !isSpotDirection(k.direction));
        const spotKeys = keysToScan.filter((k) => isSpotDirection(k.direction));

        const perpCandidates =
            perpKeys.length > 0
                ? await DBService.getTradesToAlert(
                      perpKeys,
                      config.hyperliquid.minNotionalUSD,
                      config.hyperliquid.aggregationWindowMs
                  )
                : [];

        const spotCandidates =
            spotKeys.length > 0
                ? await DBService.getTradesToAlert(
                      spotKeys,
                      config.hyperliquid.minSpotNotionalUSD,
                      config.hyperliquid.aggregationWindowMs
                  )
                : [];

        const candidates = [...perpCandidates, ...spotCandidates];

        this.logger.info(
            `Found ${candidates.length} candidates needing alert (${perpCandidates.length} perp, ${spotCandidates.length} spot)`
        );
        this.lastScanTimestamp = Date.now();
        if (candidates.length === 0) return;

        const uniqueWallets = [...new Set(candidates.map((c) => c.wallet))];
        const walletData = await this.prefetchWalletData(uniqueWallets);

        for (const candidate of candidates) {
            this.lastScanTimestamp = Date.now();
            try {
                const data = walletData.get(candidate.wallet);
                if (!data) {
                    this.logger.debug(`No prefetched data for wallet ${candidate.wallet}, skipping`);
                    continue;
                }
                if (isSpotDirection(candidate.direction)) {
                    await this.processSpotTwap(candidate, data.portfolio, data.state);
                    await this.processSpotAlertCandidate(candidate, data.portfolio, data.state);
                } else {
                    await this.processPerpTwap(candidate, data.portfolio, data.state);
                    await this.processAlertCandidate(candidate, data.portfolio, data.state);
                }
            } catch (error) {
                this.logger.error(
                    `Failed to alert wallet ${candidate.wallet} / ${candidate.coin} / ${candidate.direction}: ${error}`
                );
            }
        }
        this.lastScanTimestamp = Date.now();
    }

    private async trackAndAlert(): Promise<void> {
        const trackedWallets = await DBService.getExpiredTrackedWallets();
        this.logger.info(`Found ${trackedWallets.length} tracked wallets to check`);

        for (const tracked of trackedWallets) {
            try {
                await this.processTrackedWallet(tracked);
            } catch (error) {
                this.logger.error(
                    `Failed to check tracked wallet ${tracked.wallet} / ${tracked.coin} / ${tracked.direction}: ${error}`
                );
            }
        }
    }

    private async processTrackedWallet(tracked: HyperTrackedRecord): Promise<void> {
        const state = await this.api.fetchTraderState(tracked.wallet);
        if (!state.perp || !state.spot) {
            this.logger.info(`Unable to fetch state for tracked wallet ${tracked.wallet}`);
            return;
        }

        const currentPosition = state.perp.assetPositions?.find((pos) => pos.position?.coin === tracked.coin);

        if (!currentPosition || !currentPosition.position) {
            await this.sendPositionChangedMessage(
                tracked.id,
                tracked.wallet,
                tracked.coin,
                tracked.direction,
                'closed'
            );
            await DBService.removeTrackedWalletById(tracked.id);
            return;
        }

        const currentSzi = parseFloat(currentPosition.position.szi || '0');
        const currentDirection: HyperTradeDirection = currentSzi > 0 ? 'long' : 'short';

        if (currentDirection !== tracked.direction) {
            await this.sendPositionChangedMessage(
                tracked.id,
                tracked.wallet,
                tracked.coin,
                tracked.direction,
                'direction'
            );
            await DBService.removeTrackedWalletById(tracked.id);
            return;
        }

        const currentNotional = Math.abs(currentSzi) * parseFloat(currentPosition.position.entryPx || '0');
        const increaseThreshold = tracked.totalNotional * (1 + config.hyperliquid.minimalGrowthPercent / 100);
        const decreaseThreshold = tracked.totalNotional * (1 - config.hyperliquid.minimalGrowthPercent / 100);
        if (currentNotional > increaseThreshold || currentNotional < decreaseThreshold) {
            await this.sendPositionChangedMessage(tracked.id, tracked.wallet, tracked.coin, tracked.direction, 'size', {
                previousNotional: tracked.totalNotional,
                currentNotional,
                currentPosition
            });
            await DBService.addUpdateTrackedWallet(
                tracked.wallet,
                tracked.coin,
                tracked.direction,
                currentNotional,
                config.hyperliquid.trackedCheckIntervalMs
            );
        } else {
            await DBService.addUpdateTrackedWallet(
                tracked.wallet,
                tracked.coin,
                tracked.direction,
                tracked.totalNotional,
                config.hyperliquid.trackedCheckIntervalMs
            );
        }
    }

    private buildSocketGroups(perpNames: string[], spotNames: string[]): string[][] {
        const MAX_SOCKETS = 10;

        const groups: string[][] = [];
        const numRestSockets = MAX_SOCKETS - groups.length;
        const all = perpNames.concat(spotNames);

        const restChunkSize = Math.ceil(all.length / numRestSockets);
        for (let i = 0; i < all.length; i += restChunkSize) {
            groups.push(all.slice(i, i + restChunkSize));
        }

        if (groups.length > MAX_SOCKETS)
            throw new Error(`Too many socket groups: ${groups.length}, expected max ${MAX_SOCKETS}`);
        return groups;
    }

    private reconnectWebSocket(slot: SocketSlot): void {
        if (slot.reconnecting) return;
        slot.reconnecting = true;

        if (slot.pingInterval) {
            clearInterval(slot.pingInterval);
            slot.pingInterval = null;
        }
        if (slot.ws) {
            slot.ws.onclose = null;
            slot.ws.onerror = null;
            slot.ws.close();
            slot.ws = null;
        }

        if (this.running) {
            const delay = computeBackoffDelayMs(slot.reconnectAttempts, config.hyperliquid.retry);
            slot.reconnectAttempts++;
            this.logger.warn(
                `Reconnecting WebSocket in ${Math.round(delay / 1000)}s (attempt ${slot.reconnectAttempts})`
            );
            setTimeout(() => {
                slot.reconnecting = false;
                if (this.running) {
                    slot.ws = this.connectWebSocket(slot);
                }
            }, delay);
        } else {
            slot.reconnecting = false;
        }
    }

    private connectWebSocket(slot: SocketSlot): WebSocket {
        const ws = new WebSocket(config.hyperliquid.wss);

        ws.onopen = () => {
            slot.reconnectAttempts = 0;
            this.logger.info(
                `WebSocket connected, subscribing to ${slot.coins.length} coins: ${slot.coins.join(', ')}`
            );
            for (const coin of slot.coins) {
                ws.send(JSON.stringify({ method: 'subscribe', subscription: { type: 'trades', coin } }));
            }
            slot.pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method: 'ping' }));
            }, 30000);
        };

        ws.onmessage = (event) => {
            const rawData = typeof event.data === 'string' ? event.data : event.data.toString();
            const message = JSON.parse(rawData);
            if (message.channel === 'trades') {
                for (const trade of message.data as WsTrade[]) {
                    if (
                        trade.sz === '0' ||
                        trade.hash === '0x0000000000000000000000000000000000000000000000000000000000000000'
                    ) {
                        continue;
                    }
                    void this.handleTrade(trade, trade.coin).catch((error) =>
                        this.logger.error(`Failed to handle trade for coin ${trade.coin}: ${error}`)
                    );
                }
            }
        };

        ws.onerror = (error) => {
            this.logger.error(`WebSocket error: ${error}`);
            if (ws.readyState !== WebSocket.OPEN) this.reconnectWebSocket(slot);
        };

        ws.onclose = (event) => {
            const reason = event.reason || 'unknown';
            this.logger.info(`WebSocket closed, reason: ${reason}`);
            this.reconnectWebSocket(slot);
        };

        return ws;
    }

    async getCoinStats(coin: string): Promise<string> {
        try {
            const perpsStats = await this.api.fetchPerpMeta();
            const spotStats = await this.api.fetchSpotMeta();

            if (!perpsStats || !spotStats) {
                return 'Failed to fetch market statistics. Please try again later.';
            }

            const lines: string[] = [`📊 <b>Market Stats:</b> <code>$${escapeHtml(coin)}</code>`, ''];

            const perpIndex = perpsStats.universe.findIndex((u) => u.name === coin);
            if (perpIndex !== -1) {
                const perpMetaItem = perpsStats.universe[perpIndex];
                const perpCtx = perpsStats.assetMeta[perpIndex];

                lines.push('🔷 <b>Perpetuals</b>');
                lines.push('');

                lines.push(`<b>Max Leverage:</b> <code>${perpMetaItem.maxLeverage}x</code>`);
                if (perpMetaItem.onlyIsolated) lines.push(`<b>Mode:</b> <code>Isolated Only</code>`);

                if (perpCtx) {
                    lines.push(`Mark Price: <code>$${perpCtx.markPx}</code>`);
                    lines.push(`Mid Price: <code>$${perpCtx.midPx}</code>`);
                    lines.push(`Oracle Price: <code>$${perpCtx.oraclePx}</code>`);
                    lines.push('');
                    lines.push(`24h Volume: <code>${formatCurrency(parseFloat(perpCtx.dayNtlVlm))}</code>`);
                    lines.push(`Open Interest: <code>${parseFloat(perpCtx.openInterest).toFixed(2)}</code>`);
                    lines.push(`Funding Rate: <code>${(parseFloat(perpCtx.funding) * 100).toFixed(4)}%</code>`);
                    lines.push(`Premium: <code>${(parseFloat(perpCtx.premium) * 100).toFixed(4)}%</code>`);

                    const priceChange =
                        ((parseFloat(perpCtx.markPx) - parseFloat(perpCtx.prevDayPx)) / parseFloat(perpCtx.prevDayPx)) *
                        100;
                    const changeIcon = priceChange >= 0 ? '📈' : '📉';
                    lines.push(`<b>24h Change:</b> <code>${priceChange.toFixed(2)}%</code> ${changeIcon}`);
                }
                lines.push('');
            }

            let spotPair: { name: string; tokens: number[]; index: number; isCanonical: boolean } | undefined;
            const coinToken = spotStats.tokens.find((t) => t.name === coin);
            if (coinToken) spotPair = spotStats.universe.find((u) => u.tokens[0] === coinToken.index);

            if (spotPair) {
                const baseToken = spotStats.tokens.find((t) => t.index === spotPair!.tokens[0]);
                const quoteToken = spotStats.tokens.find((t) => t.index === spotPair!.tokens[1]);
                const spotCtx = spotStats.assetMeta[spotPair.index];

                lines.push('🔶 <b>Spot</b>');
                lines.push('');

                if (baseToken) {
                    lines.push(`<b>Base Token:</b> <code>${escapeHtml(baseToken.name)}</code>`);
                }
                if (quoteToken) {
                    lines.push(`<b>Quote Token:</b> <code>${escapeHtml(quoteToken.name)}</code>`);
                }
                lines.push(`<b>Canonical:</b> <code>${spotPair.isCanonical ? 'Yes' : 'No'}</code>`);

                if (spotCtx) {
                    lines.push('');
                    lines.push(`Mark Price: <code>$${spotCtx.markPx}</code>`);
                    lines.push(`Mid Price: <code>$${spotCtx.midPx}</code>`);
                    lines.push('');
                    lines.push(`24h Volume: <code>${formatCurrency(parseFloat(spotCtx.dayNtlVlm))}</code>`);

                    const priceChange =
                        ((parseFloat(spotCtx.markPx) - parseFloat(spotCtx.prevDayPx)) / parseFloat(spotCtx.prevDayPx)) *
                        100;
                    const changeIcon = priceChange >= 0 ? '📈' : '📉';
                    lines.push(`<b>24h Change:</b> <code>${priceChange.toFixed(2)}%</code> ${changeIcon}`);
                }
            }

            return lines.join('\n');
        } catch (error) {
            this.logger.error(`getCoinStats error: ${error}`);
            return 'An error occurred while fetching coin stats. Please try again later.';
        }
    }

    async flushTradeBatch(): Promise<void> {
        await this.flushMutex.runExclusive(async () => {
            if (this.tradeBatch.length === 0) return;
            const batchToFlush = [...this.tradeBatch];
            this.tradeBatch = [];
            this.lastDataTimestamp = Date.now();

            try {
                this.logger.info(`Flushing trade batch of size ${batchToFlush.length}`);
                await DBService.addTradesBulk(batchToFlush, config.hyperliquid.aggregationWindowMs);
                for (const trade of batchToFlush) {
                    const keyStr = `${trade.wallet}:${trade.coin}:${trade.direction}`;
                    if (!this.affectedKeys.has(keyStr)) {
                        this.affectedKeys.set(keyStr, {
                            wallet: trade.wallet,
                            coin: trade.coin,
                            direction: trade.direction
                        });
                    }
                }
            } catch (error) {
                this.logger.error(`Error flushing trade batch: ${error}`);
            }
        });
    }

    async handleTrade(trade: WsTrade, coin: string): Promise<void> {
        const notional = parseFloat(trade.px) * parseFloat(trade.sz);
        if (!Number.isFinite(notional) || notional < config.hyperliquid.minTradeNotionalUSD) {
            return;
        }

        const isZeroAddress = (wallet: string) => wallet === '0x0000000000000000000000000000000000000000';

        const buyer = trade.users[0];
        const seller = trade.users[1];

        if (this.spotCoinMap.has(coin)) {
            const displayCoin = this.spotCoinMap.get(coin) ?? coin;
            if (buyer && !isZeroAddress(buyer)) {
                this.tradeBatch.push({
                    wallet: buyer,
                    coin: displayCoin,
                    notional,
                    tradeTime: trade.time,
                    direction: 'spot_buy'
                });
            }
            if (seller && !isZeroAddress(seller)) {
                this.tradeBatch.push({
                    wallet: seller,
                    coin: displayCoin,
                    notional,
                    tradeTime: trade.time,
                    direction: 'spot_sell'
                });
            }
        } else {
            if (buyer && !isZeroAddress(buyer)) {
                this.tradeBatch.push({ wallet: buyer, coin, notional, tradeTime: trade.time, direction: 'long' });
            }
            if (seller && !isZeroAddress(seller)) {
                this.tradeBatch.push({ wallet: seller, coin, notional, tradeTime: trade.time, direction: 'short' });
            }
        }

        if (this.tradeBatch.length >= config.hyperliquid.batchSize) await this.flushTradeBatch();
    }

    private async sendPositionChangedMessage(
        id: string,
        wallet: string,
        coin: string,
        direction: HyperTradeDirection,
        reason: 'closed' | 'liquidated' | 'direction' | 'size',
        extra?: {
            previousNotional?: number;
            currentNotional?: number;
            currentPosition?: AssetPosition;
        }
    ): Promise<void> {
        const directionIcon = direction === 'long' ? '🟢' : '🔴';
        const directionLabel = direction === 'long' ? 'Long' : 'Short';

        let reasonIcon: string;
        let reasonLabel: string;
        const lines: string[] = [];

        switch (reason) {
            case 'closed':
                reasonIcon = '✅';
                reasonLabel = 'Position Closed';
                lines.push(
                    `${reasonIcon} <b>${reasonLabel}</b>`,
                    '',
                    `${directionIcon} <b>Coin:</b> <code>${escapeHtml(coin)}</code> (${directionLabel})`,
                    '',
                    `Wallet: <code>${escapeHtml(wallet)}</code>`
                );
                break;

            case 'liquidated':
                reasonIcon = '⚠️';
                reasonLabel = 'Position Liquidated';
                lines.push(
                    `${reasonIcon} <b>${reasonLabel}</b>`,
                    '',
                    `${directionIcon} <b>Coin:</b> <code>${escapeHtml(coin)}</code> (${directionLabel})`,
                    '',
                    `Wallet: <code>${escapeHtml(wallet)}</code>`
                );
                break;

            case 'direction':
                reasonIcon = '🔄';
                reasonLabel = 'Position Direction Changed';
                lines.push(
                    `${reasonIcon} <b>${reasonLabel}</b>`,
                    '',
                    `${directionIcon} <b>Coin:</b> <code>${escapeHtml(coin)}</code> (${directionLabel})`,
                    '',
                    `Wallet: <code>${escapeHtml(wallet)}</code>`
                );
                break;

            case 'size':
                if (!extra?.currentPosition?.position || !extra.previousNotional || !extra.currentNotional) {
                    this.logger.error('sendPositionChangedMessage: Missing required data for increased position');
                    return;
                }

                const { rank, pnl, entryPrice } = this.api.extractPositionDetails(extra.currentPosition.position);
                const changePercent = (extra.currentNotional / extra.previousNotional) * 100 - 100;

                reasonIcon = '📈';
                reasonLabel = 'Position Size Changed';
                lines.push(
                    `${reasonIcon} <b>${reasonLabel}</b>`,
                    '',
                    `${directionIcon} <b>Coin:</b> <code>${escapeHtml(coin)}</code> (${directionLabel})`,
                    '',
                    `<b>Previous Size:</b> <code>${formatCurrency(extra.previousNotional)}</code>`,
                    `<b>Current Size:</b> <code>${formatCurrency(extra.currentNotional)}</code>`,
                    `<b>Change:</b> <code>${changePercent.toFixed(2)}%</code>`,
                    '',
                    `<b>Leverage:</b> <code>${rank.toFixed(2)}x</code>`,
                    `<b>Entry Price:</b> <code>${escapeHtml(entryPrice)}</code>`,
                    `<b>Unrealized PnL:</b> <code>${formatCurrency(pnl)}</code>`,
                    '',
                    `Wallet: <code>${escapeHtml(wallet)}</code>`
                );
                break;
        }

        const buttons: InlineKeyboardMarkup = {
            inline_keyboard: [
                [
                    {
                        text: '🔗 View on Hypurrscan',
                        url: `${this.hypurrscanExplorer}/address/${encodeURIComponent(wallet)}`
                    }
                ],
                reason !== 'closed' && reason !== 'liquidated'
                    ? [Markup.button.callback('🗑️ Untrack Wallet', `untrack:${id}`, true)]
                    : []
            ]
        };

        try {
            for (let i = 0; i < this.trackChannels.length; i++) {
                if (i > 0) await sleep(1000);
                const channel = this.trackChannels[i];
                await this.tg.sendMessage(channel.chatId, lines.join('\n'), {
                    message_thread_id: channel.topicId,
                    reply_markup: buttons
                });
            }
        } catch (error) {
            this.logger.error(`Failed to send position changed message: ${error}`);
        }
    }

    private async prefetchWalletData(
        wallets: string[],
        concurrency = 5
    ): Promise<Map<string, { portfolio: TraderPortfolio; state: TraderState }>> {
        const WALLET_FETCH_TIMEOUT = 20_000;
        const result = new Map<string, { portfolio: TraderPortfolio; state: TraderState }>();
        const totalBatches = Math.ceil(wallets.length / concurrency);

        this.logger.info(
            `Prefetching data for ${wallets.length} unique wallets (${totalBatches} batches, concurrency=${concurrency})`
        );

        for (let i = 0; i < wallets.length; i += concurrency) {
            const batchIndex = Math.floor(i / concurrency) + 1;
            const batch = wallets.slice(i, i + concurrency);
            const batchStart = Date.now();

            this.logger.debug(`Prefetch batch ${batchIndex}/${totalBatches}: fetching ${batch.length} wallets`);

            const settled = await Promise.allSettled(
                batch.map(async (wallet) => {
                    const fetchData = async () => {
                        const [portfolio, state] = await Promise.all([
                            this.api.fetchPortfolio(wallet),
                            this.api.fetchTraderState(wallet)
                        ]);
                        return { wallet, portfolio, state };
                    };
                    return new Promise<{ wallet: string; portfolio: TraderPortfolio | null; state: TraderState }>(
                        (resolve, reject) => {
                            const timer = setTimeout(
                                () =>
                                    reject(
                                        new Error(`Timeout fetching wallet ${wallet} after ${WALLET_FETCH_TIMEOUT}ms`)
                                    ),
                                WALLET_FETCH_TIMEOUT
                            );
                            fetchData().then(
                                (val) => {
                                    clearTimeout(timer);
                                    resolve(val);
                                },
                                (err) => {
                                    clearTimeout(timer);
                                    reject(err);
                                }
                            );
                        }
                    );
                })
            );

            let batchSuccess = 0;
            let batchSkipped = 0;
            for (const res of settled) {
                if (res.status === 'fulfilled') {
                    const { wallet, portfolio, state } = res.value;
                    if (portfolio && state.perp && state.spot) {
                        result.set(wallet, { portfolio, state });
                        batchSuccess++;
                    } else {
                        batchSkipped++;
                        this.logger.debug(
                            `Skipping wallet ${wallet}: portfolio=${!!portfolio}, perp=${!!state.perp}, spot=${!!state.spot}`
                        );
                    }
                } else {
                    batchSkipped++;
                    this.logger.error(`Failed to prefetch wallet data: ${res.reason}`);
                }
            }

            const timeTaken = ((Date.now() - batchStart) / 1000).toFixed(1);
            this.logger.info(
                `Prefetch batch ${batchIndex}/${totalBatches} done in ${timeTaken}s: ${batchSuccess} ok, ${batchSkipped} skipped`
            );
            this.lastScanTimestamp = Date.now();
        }

        this.logger.info(`Prefetch complete: ${result.size}/${wallets.length} wallets ready`);
        return result;
    }

    private async processAlertCandidate(
        candidate: HyperAggregationRecord,
        portfolio: TraderPortfolio,
        state: TraderState
    ): Promise<void> {
        this.logger.debug(
            `Detected high-value perps trade: ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
        );

        const positionState = state.perp!.assetPositions?.find((pos) => pos.position?.coin === candidate.coin);
        if (!positionState || !positionState.position) {
            this.logger.debug(
                `Skipping alert for high-value perps trade (no position found): ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
            );
            return;
        }
        const direction: HyperTradeDirection = parseFloat(positionState.position.szi) > 0 ? 'long' : 'short';
        if (direction !== candidate.direction) {
            this.logger.debug(
                `Skipping alert for high-value perps trade (direction mismatch): ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
            );
            return;
        }
        const upstreamTotalNotional = Math.abs(
            parseFloat(positionState.position.szi) * parseFloat(positionState.position.entryPx || '0')
        );
        if (upstreamTotalNotional < config.hyperliquid.minNotionalUSD) {
            this.logger.debug(
                `Skipping alert for high-value perps trade (upstream notional too low): ${candidate.wallet} ${candidate.coin} ${formatCurrency(upstreamTotalNotional)} (${candidate.direction})`
            );
            return;
        }
        candidate.totalNotional = upstreamTotalNotional;
        await DBService.updateTradeNotional(candidate.id, candidate.totalNotional);

        const accountTag = classifyAccountTag(state, portfolio);
        const branches = classifyBranches(candidate.coin, candidate.totalNotional, accountTag);

        if (branches.length === 0) {
            this.logger.debug(
                `No branch matched for ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
            );
            return;
        }

        let screenshot: Buffer | null = null;
        if (this.screenshotEnabled) {
            try {
                screenshot = await this.screenshoter.capture(
                    `${this.hypurrscanExplorer}/address/${candidate.wallet}#perps`,
                    undefined,
                    () => {
                        const result = document.evaluate(
                            '//div[text()=" Overview "]/div/span',
                            document,
                            null,
                            XPathResult.FIRST_ORDERED_NODE_TYPE,
                            null
                        );
                        const el = result.singleNodeValue as Element | null;
                        if (!el?.textContent) return false;
                        const num = parseFloat(el.textContent.replace(/,/g, '').replace('$', ''));
                        return !isNaN(num) && num > 0;
                    }
                );
            } catch (err) {
                this.logger.warn(`Screenshot failed for ${candidate.wallet}, sending alert without image: ${err}`);
            }
        }

        for (const branch of branches) {
            await this.sendBranchAlert(branch, candidate, state, portfolio, positionState!, screenshot);
        }
    }

    private async sendBranchAlert(
        branch: AlertBranch,
        candidate: HyperAggregationRecord,
        state: TraderState,
        portfolio: TraderPortfolio,
        positionState: AssetPosition,
        screenshot: Buffer | null
    ): Promise<void> {
        const alertChannels = this.getChannelsForBranch(branch);

        const lastAlerts = await DBService.getLastAlerts(
            candidate.wallet,
            candidate.coin,
            candidate.direction,
            alertChannels.map((c) => c.chatId),
            branch
        );

        if (lastAlerts.size > 0) {
            const latestAlert = [...lastAlerts.values()].reduce((a, b) =>
                new Date(a.sentAt) > new Date(b.sentAt) ? a : b
            );
            const growth = candidate.totalNotional - latestAlert.totalNotional;
            const dynamicThreshold = Math.max(
                (latestAlert.totalNotional * config.hyperliquid.minimalGrowthPercent) / 100,
                config.hyperliquid.minimalGrowthUSD
            );
            if (growth < dynamicThreshold) {
                this.logger.debug(
                    `Skipping ${branch} for ${candidate.wallet} ${candidate.coin}: growth ${growth} < threshold ${dynamicThreshold}`
                );
                return;
            }

            this.logger.info(
                `Re-alert ${branch} for ${candidate.wallet} ${candidate.coin}: growth ${growth} >= threshold ${dynamicThreshold}`
            );
            const replyText = this.formatGrowingPositionMessage(candidate.totalNotional, latestAlert.totalNotional);
            for (let i = 0; i < alertChannels.length; i++) {
                if (i > 0) await sleep(1000);
                const channel = alertChannels[i];
                const prevAlert = lastAlerts.get(channel.chatId);
                let messageId: number | undefined;
                if (prevAlert?.messageId) {
                    await this.tg.sendReply(channel.chatId, replyText, prevAlert.messageId);
                    messageId = prevAlert.messageId;
                } else {
                    messageId = await this.tg.sendMessage(channel.chatId, replyText, {
                        message_thread_id: channel.topicId
                    });
                }
                await DBService.insertAlert({
                    wallet: candidate.wallet,
                    coin: candidate.coin,
                    direction: candidate.direction,
                    totalNotional: candidate.totalNotional,
                    sentAt: new Date(),
                    chatId: channel.chatId,
                    messageId,
                    branch
                });
            }
            return;
        }

        this.logger.info(
            `Sending ${branch} alert: ${candidate.wallet} ${candidate.coin} ${formatCurrency(candidate.totalNotional)} (${candidate.direction})`
        );

        const result = this.formatBranchAlert(branch, { candidate, state, portfolio }, positionState!);
        if (!result) return;
        const { msg, buttons } = result;

        for (let i = 0; i < alertChannels.length; i++) {
            if (i > 0) await sleep(1000);
            const channel = alertChannels[i];
            let messageId: number | undefined;
            if (screenshot) {
                messageId = await this.tg.sendPhoto(channel.chatId, screenshot, msg, {
                    reply_markup: buttons,
                    message_thread_id: channel.topicId
                });
            } else {
                messageId = await this.tg.sendMessage(channel.chatId, msg, {
                    message_thread_id: channel.topicId,
                    reply_markup: buttons
                });
            }
            await DBService.insertAlert({
                wallet: candidate.wallet,
                coin: candidate.coin,
                direction: candidate.direction,
                totalNotional: candidate.totalNotional,
                sentAt: new Date(),
                chatId: channel.chatId,
                messageId,
                branch
            });
        }
    }

    private async processPerpTwap(
        candidate: HyperAggregationRecord,
        portfolio: TraderPortfolio,
        state: TraderState
    ): Promise<void> {
        const twap = this.detectTwap(candidate);
        if (!twap) return;

        const alertChannels = this.getChannelsForBranch('BIG_TWAP');
        const branch: AlertBranch = 'BIG_TWAP';
        const isSell = candidate.direction === 'short';

        const twapCandidate: HyperAggregationRecord = {
            ...candidate,
            trades: twap.windowTrades,
            tradeCount: twap.windowTrades.length,
            totalNotional: twap.windowNotional
        };

        const lastAlerts = await DBService.getLastAlerts(
            twapCandidate.wallet,
            twapCandidate.coin,
            twapCandidate.direction,
            alertChannels.map((c) => c.chatId),
            branch
        );

        if (lastAlerts.size > 0) {
            const latestAlert = [...lastAlerts.values()].reduce((a, b) =>
                new Date(a.sentAt) > new Date(b.sentAt) ? a : b
            );
            const growth = twapCandidate.totalNotional - latestAlert.totalNotional;
            const dynamicThreshold = Math.max(
                (latestAlert.totalNotional * config.hyperliquid.minimalGrowthPercent) / 100,
                config.hyperliquid.minimalGrowthUSD
            );
            if (growth < dynamicThreshold) {
                this.logger.debug(
                    `Skipping perp TWAP re-alert ${twapCandidate.wallet} ${twapCandidate.coin}: growth ${growth} < threshold ${dynamicThreshold}`
                );
                return;
            }

            const replyText = this.formatGrowingPositionMessage(
                twapCandidate.totalNotional,
                latestAlert.totalNotional,
                isSell ? '🔥 <b>Selling more</b>' : '🔥 <b>Growing position</b>'
            );
            for (let i = 0; i < alertChannels.length; i++) {
                if (i > 0) await sleep(1000);
                const channel = alertChannels[i];
                const prevAlert = lastAlerts.get(channel.chatId);
                let messageId: number | undefined;
                if (prevAlert?.messageId) {
                    await this.tg.sendReply(channel.chatId, replyText, prevAlert.messageId);
                    messageId = prevAlert.messageId;
                } else {
                    messageId = await this.tg.sendMessage(channel.chatId, replyText, {
                        message_thread_id: channel.topicId
                    });
                }
                await DBService.insertAlert({
                    wallet: twapCandidate.wallet,
                    coin: twapCandidate.coin,
                    direction: twapCandidate.direction,
                    totalNotional: twapCandidate.totalNotional,
                    sentAt: new Date(),
                    chatId: channel.chatId,
                    messageId,
                    branch
                });
            }
            return;
        }

        this.logger.info(
            `Sending BIG_TWAP alert (perp): ${twapCandidate.wallet} ${twapCandidate.coin} ${formatCurrency(twapCandidate.totalNotional)}`
        );

        const result = await this.formatTwapAlert(twapCandidate, state, portfolio, 'perp');
        if (!result) return;
        const { msg, buttons } = result;

        for (let i = 0; i < alertChannels.length; i++) {
            if (i > 0) await sleep(1000);
            const channel = alertChannels[i];
            const messageId = await this.tg.sendMessage(channel.chatId, msg, {
                message_thread_id: channel.topicId,
                reply_markup: buttons
            });
            await DBService.insertAlert({
                wallet: twapCandidate.wallet,
                coin: twapCandidate.coin,
                direction: twapCandidate.direction,
                totalNotional: twapCandidate.totalNotional,
                sentAt: new Date(),
                chatId: channel.chatId,
                messageId,
                branch
            });
        }
    }

    private async processSpotAlertCandidate(
        _candidate: HyperAggregationRecord,
        _portfolio: TraderPortfolio,
        _state: TraderState
    ): Promise<void> {}

    private async processSpotTwap(
        candidate: HyperAggregationRecord,
        portfolio: TraderPortfolio,
        state: TraderState
    ): Promise<void> {
        const twap = this.detectTwap(candidate);
        if (!twap) return;

        const alertChannels = this.getChannelsForBranch('BIG_TWAP');
        const branch: AlertBranch = 'BIG_TWAP';
        const isSell = isSpotSellDirection(candidate.direction);

        const twapCandidate: HyperAggregationRecord = {
            ...candidate,
            trades: twap.windowTrades,
            tradeCount: twap.windowTrades.length,
            totalNotional: twap.windowNotional
        };

        const lastAlerts = await DBService.getLastAlerts(
            twapCandidate.wallet,
            twapCandidate.coin,
            twapCandidate.direction,
            alertChannels.map((c) => c.chatId),
            branch
        );

        if (lastAlerts.size > 0) {
            const latestAlert = [...lastAlerts.values()].reduce((a, b) =>
                new Date(a.sentAt) > new Date(b.sentAt) ? a : b
            );
            const growth = twapCandidate.totalNotional - latestAlert.totalNotional;
            const dynamicThreshold = Math.max(
                (latestAlert.totalNotional * config.hyperliquid.minimalGrowthPercent) / 100,
                config.hyperliquid.minimalGrowthUSD
            );
            if (growth < dynamicThreshold) {
                this.logger.debug(
                    `Skipping spot TWAP re-alert ${twapCandidate.wallet} ${twapCandidate.coin}: growth ${growth} < threshold ${dynamicThreshold}`
                );
                return;
            }

            const replyText = this.formatGrowingPositionMessage(
                twapCandidate.totalNotional,
                latestAlert.totalNotional,
                isSell ? '🔥 <b>Selling more</b>' : '🔥 <b>Growing position</b>'
            );
            for (let i = 0; i < alertChannels.length; i++) {
                if (i > 0) await sleep(1000);
                const channel = alertChannels[i];
                const prevAlert = lastAlerts.get(channel.chatId);
                let messageId: number | undefined;
                if (prevAlert?.messageId) {
                    await this.tg.sendReply(channel.chatId, replyText, prevAlert.messageId);
                    messageId = prevAlert.messageId;
                } else {
                    messageId = await this.tg.sendMessage(channel.chatId, replyText, {
                        message_thread_id: channel.topicId
                    });
                }
                await DBService.insertAlert({
                    wallet: twapCandidate.wallet,
                    coin: twapCandidate.coin,
                    direction: twapCandidate.direction,
                    totalNotional: twapCandidate.totalNotional,
                    sentAt: new Date(),
                    chatId: channel.chatId,
                    messageId,
                    branch
                });
            }
            return;
        }

        this.logger.info(
            `Sending BIG_TWAP alert (spot): ${twapCandidate.wallet} ${twapCandidate.coin} ${formatCurrency(twapCandidate.totalNotional)}`
        );

        const result = await this.formatTwapAlert(twapCandidate, state, portfolio, 'spot');
        if (!result) return;
        const { msg, buttons } = result;

        let screenshot: Buffer | null = null;
        if (this.screenshotEnabled) {
            try {
                screenshot = await this.screenshoter.capture(
                    `${this.hypurrscanExplorer}/address/${twapCandidate.wallet}#spot`,
                    undefined,
                    () => {
                        const result = document.evaluate(
                            '//div[text()=" Overview "]/div/span',
                            document,
                            null,
                            XPathResult.FIRST_ORDERED_NODE_TYPE,
                            null
                        );
                        const el = result.singleNodeValue as Element | null;
                        if (!el?.textContent) return false;
                        const num = parseFloat(el.textContent.replace(/,/g, '').replace('$', ''));
                        return !isNaN(num) && num > 0;
                    }
                );
            } catch (err) {
                this.logger.warn(
                    `Screenshot failed for ${twapCandidate.wallet} spot, sending alert without image: ${err}`
                );
            }
        }
        for (let i = 0; i < alertChannels.length; i++) {
            if (i > 0) await sleep(1000);
            const channel = alertChannels[i];
            let messageId: number | undefined;
            if (screenshot) {
                messageId = await this.tg.sendPhoto(channel.chatId, screenshot, msg, {
                    reply_markup: buttons,
                    message_thread_id: channel.topicId
                });
            } else {
                messageId = await this.tg.sendMessage(channel.chatId, msg, {
                    message_thread_id: channel.topicId,
                    reply_markup: buttons
                });
            }
            await DBService.insertAlert({
                wallet: twapCandidate.wallet,
                coin: twapCandidate.coin,
                direction: twapCandidate.direction,
                totalNotional: twapCandidate.totalNotional,
                sentAt: new Date(),
                chatId: channel.chatId,
                messageId,
                branch
            });
        }
    }

    private detectTwap(
        candidate: HyperAggregationRecord
    ): { windowTrades: TradeSnapshot[]; windowNotional: number } | null {
        const coinBase = normalizeSpotTicker(candidate.coin.split('/')[0]);
        const threshold = config.hyperliquid.twapCoinThresholds[coinBase];
        if (threshold === undefined) return null;

        const trades = candidate.trades || [];
        if (trades.length < config.hyperliquid.twapMinFills) return null;

        const sorted = [...trades].sort((a, b) => a.ts - b.ts);

        let burst: TradeSnapshot[] = [sorted[sorted.length - 1]];
        for (let i = sorted.length - 2; i >= 0; i--) {
            if (burst[0].ts - sorted[i].ts > config.hyperliquid.twapMaxGapMs) break;
            burst.unshift(sorted[i]);
        }
        if (burst.length < config.hyperliquid.twapMinFills) return null;

        const windowNotional = burst.reduce((sum, t) => sum + Math.abs(t.size), 0);
        if (windowNotional < threshold) return null;

        const durationMs = burst[burst.length - 1].ts - burst[0].ts;
        if (durationMs <= 0) return null;
        const avgIntervalMs = durationMs / (burst.length - 1);
        if (avgIntervalMs > config.hyperliquid.twapMaxIntervalMs) return null;

        return { windowTrades: burst, windowNotional };
    }

    private async formatTwapAlert(
        candidate: HyperAggregationRecord,
        state: TraderState,
        portfolio: TraderPortfolio,
        market: 'spot' | 'perp' = 'spot'
    ): Promise<{ msg: string; buttons: InlineKeyboardMarkup } | null> {
        if (!state.perp || !state.spot) return null;
        const accountTag = classifyAccountTag(state, portfolio);
        const { first: firstTimestamp } = getPortfolioTimestamps(portfolio);
        const firstDepositAgo = firstTimestamp ? formatTimeAgo(firstTimestamp) : 'Unknown';
        const compressedWallet = `${candidate.wallet.slice(0, 6)}...${candidate.wallet.slice(-4)}`;

        const trades = candidate.trades || [];
        let sigma = 0;
        let durationMs = 0;
        let cycleIntervalMs = 0;

        if (trades.length >= 2) {
            const sorted = [...trades].sort((a, b) => a.ts - b.ts);
            durationMs = sorted[sorted.length - 1].ts - sorted[0].ts;
            cycleIntervalMs = durationMs / (sorted.length - 1);

            // Sigma: coefficient of variation of trade sizes (std dev / mean as %)
            const sizes = sorted.map((t) => Math.abs(t.size));
            const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
            if (mean > 0) {
                const variance = sizes.reduce((sum, s) => sum + (s - mean) ** 2, 0) / sizes.length;
                sigma = (Math.sqrt(variance) / mean) * 100; // as percentage
            }
        }

        const durationMinutes = Math.round(durationMs / 60000);
        const cycleCount = trades.length || candidate.tradeCount;
        const perCycleAmount = cycleCount > 0 ? candidate.totalNotional / cycleCount : 0;
        const cycleIntervalSec = Math.round(cycleIntervalMs / 1000);

        const coinBase = candidate.coin.split('/')[0];
        const displayCoin = normalizeSpotTicker(coinBase);
        let volume24h = 0;
        let marketCap = 0;
        let intensity = 0;
        let cyclePressure = 0;
        let price = 0;

        try {
            if (market === 'perp') {
                const perpMeta = await this.api.fetchPerpMeta();
                if (perpMeta) {
                    const index = perpMeta.universe.findIndex((u) => u.name === coinBase);
                    const ctx = index >= 0 ? perpMeta.assetMeta[index] : undefined;
                    if (ctx) {
                        volume24h = parseFloat(ctx.dayNtlVlm);
                        price = parseFloat(ctx.midPx);
                    }
                }
            } else {
                const spotMeta = await this.api.fetchSpotMeta();
                if (spotMeta) {
                    const token = spotMeta.tokens.find((t) => t.name === coinBase);
                    if (token) {
                        const universe = spotMeta.universe.find((u) => u.tokens[0] === token.index);
                        if (universe) {
                            const ctx = spotMeta.assetMeta[universe.index];
                            if (ctx) {
                                volume24h = parseFloat(ctx.dayNtlVlm);
                                price = parseFloat(ctx.midPx);
                            }
                        }

                        const tokenId = '0x' + token.index.toString(16).padStart(64, '0');
                        const details = await this.api.fetchTokenDetails(tokenId);
                        if (details) {
                            const supply = parseFloat(details.circulatingSupply);
                            const px = parseFloat(details.midPx);
                            if (supply > 0 && px > 0) marketCap = supply * px;
                        }
                    }
                }
            }

            const book = await this.api.fetchL2Book(coinBase);
            if (book && price > 0) {
                const depth = this.api.computeDepthFromBook(book, price, 0.5);
                if (depth > 0) {
                    cyclePressure = perCycleAmount / depth;
                }
            }

            if (durationMs > 0) {
                const tradesPerMin = cycleCount / (durationMs / 60000);
                intensity = tradesPerMin;
            }
        } catch (error) {
            this.logger.debug(`Failed to fetch market data for TWAP alert: ${error}`);
        }

        const notionalPctOfMcap = marketCap > 0 ? (candidate.totalNotional / marketCap) * 100 : 0;
        const otherPositions = getTopPositions(state.perp!.assetPositions || [], '', 3);

        const isSell = market === 'perp' ? candidate.direction === 'short' : isSpotSellDirection(candidate.direction);
        const dirIcon = isSell ? '🔴' : '🟢';
        const actionWord = isSell ? 'selling' : 'buying';
        const sideBlock = isSell ? '🟥' : '🟩';
        const durationStr =
            durationMinutes >= 60
                ? `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`
                : `${durationMinutes} minutes`;
        const cycleIntervalStr =
            cycleIntervalSec >= 60 ? `${Math.round(cycleIntervalSec / 60)}m` : `${cycleIntervalSec}s`;

        const lines = [
            `🔄 <b>BIG TWAP DETECTED</b> [${market.toUpperCase()}] 🔄`,
            '',
            `${dirIcon} <code>${formatCurrency(candidate.totalNotional)}</code> ${actionWord} <b>${escapeHtml(displayCoin)}</b> in ${durationStr} ${sideBlock}`,
            `~<code>${formatCurrency(perCycleAmount)}</code> every ${cycleIntervalStr}`,
            '',
            `σ: ${sigma.toFixed(2)}%  ·  Intensity: ${intensity.toFixed(2)}x`,
            `Cycle pressure: ${cyclePressure.toFixed(2)}x (0.5% depth)`,
            `🕐 ${durationStr} (${cycleCount} cycles)`
        ];

        if (notionalPctOfMcap > 0) {
            lines.splice(7, 0, `Notional: ${notionalPctOfMcap.toFixed(2)}% of mcap`);
        }

        if (price > 0 || volume24h > 0 || marketCap > 0) {
            lines.push('');
            lines.push('📈 <b>Market Data</b>');
            if (price > 0)
                lines.push(
                    `<b>Price:</b> <code>$${price.toLocaleString('en-US', { maximumFractionDigits: 4 })}</code>`
                );
            if (volume24h > 0) lines.push(`<b>24h Volume:</b> <code>${formatCurrency(volume24h)}</code>`);
            if (marketCap > 0) lines.push(`<b>Market Cap:</b> <code>${formatCurrency(marketCap)}</code>`);
        }

        lines.push('');
        lines.push(`👤 <b>Whale Profile</b> [<i>${accountTag.tag}</i>]`);
        lines.push(`<b>Address:</b> <code>${escapeHtml(compressedWallet)}</code>`);
        lines.push(`🕐 <b>First Deposit:</b> ${escapeHtml(firstDepositAgo)}`);
        lines.push(`💰 <b>Account Value:</b> <code>${formatCurrency(accountTag.totalValue)}</code>`);
        lines.push(
            `📊 <b>Perps:</b> <code>${formatCurrency(accountTag.perpsValue)}</code> | <b>Spot:</b> <code>${formatCurrency(accountTag.spotValue)}</code>`
        );
        lines.push(`🪙 <b>Holdings:</b> ${accountTag.perpsCount} perps | ${accountTag.spotCount} spot`);

        if (otherPositions.length > 0) {
            lines.push('');
            lines.push('📊 <b>Open Positions</b>');
            for (const pos of otherPositions) {
                const { direction: posDir, rank: posLev, pnl: posPnl } = this.api.extractPositionDetails(pos.position!);
                const posDirIcon = posDir === 'long' ? '🟢' : '🔴';
                const posNotional = Math.abs(parseFloat(pos.position!.szi) * parseFloat(pos.position!.entryPx || '0'));
                lines.push(
                    `\u2003\u2003\u2003\u2003${posDirIcon} <b>${escapeHtml(pos.position!.coin)}</b> · ${formatCurrency(posNotional)} · ${posLev.toFixed(1)}x · <code>${formatCurrency(posPnl)}</code>`
                );
            }
        }

        // Top spot holdings
        const spotBalances = state
            .spot!.balances.filter((b) => parseFloat(b.total) > 0 && b.coin !== 'USDC')
            .map((b) => ({ coin: b.coin, value: parseFloat(b.px) * parseFloat(b.total) }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 3);

        if (spotBalances.length > 0) {
            lines.push('');
            lines.push('💰 <b>Spot Holdings</b>');
            for (const bal of spotBalances) {
                lines.push(`\u2003\u2003\u2003\u2003🪙 <b>${escapeHtml(bal.coin)}</b> · ${formatCurrency(bal.value)}`);
            }
        }

        lines.push('');
        const hashCoin = displayCoin.replace(/[^a-zA-Z0-9]/g, '');
        lines.push(`#${escapeHtml(hashCoin)}_${candidate.wallet.slice(2, 6)}${candidate.wallet.slice(-4)}`);

        const hypurrscanUrl = `${this.hypurrscanExplorer}/address/${encodeURIComponent(candidate.wallet)}`;
        const hyperdashUrl = `${this.hyperdashExplorer}/address/${encodeURIComponent(candidate.wallet)}`;

        return {
            msg: lines.join('\n'),
            buttons: {
                inline_keyboard: [
                    [
                        { text: '🔗 Hypurrscan', url: hypurrscanUrl },
                        { text: '📊 Hyperdash', url: hyperdashUrl }
                    ]
                ]
            }
        };
    }

    private formatBranchAlert(
        branch: AlertBranch,
        context: AlertContext,
        positionState: AssetPosition
    ): { msg: string; buttons: InlineKeyboardMarkup } | null {
        if (!context.state.perp || !context.state.spot) return null;
        const accountTag = classifyAccountTag(context.state, context.portfolio);
        const candidate = context.candidate;
        const { direction, rank, pnl, entryPrice } = this.api.extractPositionDetails(positionState.position!);

        const directionIcon = direction === 'long' ? '🟢' : '🔴';
        const directionLabel = direction === 'long' ? 'Long' : 'Short';

        let header: string;
        switch (branch) {
            case 'FRESH_WALLET':
                header = '🆕 <b>FRESH WALLET ALERT</b> 🆕';
                break;
            case 'WHALE_ACTIVITY':
                header = '🐋 <b>WHALE ACTIVITY</b> 🐋';
                break;
            case 'BIG_WHALE':
                header = '🚨 <b>BIG WHALE MOVE</b> 🚨';
                break;
            default:
                header = '🐋 <b>WHALE ALERT</b> 🐋';
        }

        const { first: firstTimestamp } = getPortfolioTimestamps(context.portfolio);
        const firstDepositAgo = firstTimestamp ? formatTimeAgo(firstTimestamp) : 'Unknown';

        const otherPositions = getTopPositions(context.state.perp!.assetPositions || [], candidate.coin, 3);

        const compressedWallet = `${candidate.wallet.slice(0, 6)}...${candidate.wallet.slice(-4)}`;

        const lines = [
            header,
            '',
            `${directionIcon} <b>Coin:</b> <code>$${escapeHtml(candidate.coin)}</code> (${directionLabel})`,
            `💵 <b>Size:</b> <code>${formatCurrency(candidate.totalNotional)}</code>`,
            `⚡ <b>Leverage:</b> <code>${rank.toFixed(2)}x</code>`,
            `🏷 <b>Entry:</b> <code>${escapeHtml(entryPrice)}</code>`,
            `${pnl >= 0 ? '📈' : '📉'} <b>PnL:</b> <code>${formatCurrency(pnl)}</code>`,
            '',
            `👤 <b>Whale Profile</b> [<i>${accountTag.tag}</i>]`,
            `<b>Address:</b> <code>${escapeHtml(compressedWallet)}</code>`,
            `🕐 <b>First Deposit:</b> ${escapeHtml(firstDepositAgo)}`,
            `💰 <b>Account Value:</b> <code>${formatCurrency(accountTag.totalValue)}</code>`,
            `📊 <b>Perps:</b> <code>${formatCurrency(accountTag.perpsValue)}</code> | <b>Spot:</b> <code>${formatCurrency(accountTag.spotValue)}</code>`,
            `🪙 <b>Holdings:</b> ${accountTag.perpsCount} perps | ${accountTag.spotCount} spot`
        ];

        if (otherPositions.length > 0) {
            lines.push('');
            lines.push('📊 <b>Open Positions</b>');
            for (const pos of otherPositions) {
                const { direction: posDir, rank: posLev, pnl: posPnl } = this.api.extractPositionDetails(pos.position!);
                const posDirIcon = posDir === 'long' ? '🟢' : '🔴';
                const posNotional = Math.abs(parseFloat(pos.position!.szi) * parseFloat(pos.position!.entryPx || '0'));
                lines.push(
                    `\u2003\u2003\u2003\u2003${posDirIcon} <b>${escapeHtml(pos.position!.coin)}</b> · ${formatCurrency(posNotional)} · ${posLev.toFixed(1)}x · <code>${formatCurrency(posPnl)}</code>`
                );
            }
        }

        // Top spot holdings
        const spotBalances = context.state
            .spot!.balances.filter((b) => parseFloat(b.total) > 0 && b.coin !== 'USDC')
            .map((b) => ({ coin: b.coin, value: parseFloat(b.px) * parseFloat(b.total) }))
            .sort((a, b) => b.value - a.value)
            .slice(0, 3);

        if (spotBalances.length > 0) {
            lines.push('');
            lines.push('💰 <b>Spot Holdings</b>');
            for (const bal of spotBalances) {
                lines.push(`\u2003\u2003\u2003\u2003🪙 <b>${escapeHtml(bal.coin)}</b> · ${formatCurrency(bal.value)}`);
            }
        }

        lines.push('');
        const hashCoin = candidate.coin.replace(/[^a-zA-Z0-9]/g, '');
        lines.push(`#${escapeHtml(hashCoin)}_${candidate.wallet.slice(2, 6)}${candidate.wallet.slice(-4)}`);

        const hypurrscanUrl = `${this.hypurrscanExplorer}/address/${encodeURIComponent(candidate.wallet)}`;
        const hyperdashUrl = `https://hyperdash.com/address/${encodeURIComponent(candidate.wallet)}`;

        return {
            msg: lines.join('\n'),
            buttons: {
                inline_keyboard: [
                    [
                        { text: '🔗 Hypurrscan', url: hypurrscanUrl },
                        { text: '📊 Hyperdash', url: hyperdashUrl }
                    ],
                    [Markup.button.callback('📌 Track Wallet', `track:${candidate.id}`, true)]
                ]
            }
        };
    }

    private formatGrowingPositionMessage(
        currentNotional: number,
        previousNotional: number,
        title = '🔥 <b>Growing position</b>'
    ): string {
        const lines = [title, ``, `<b>${formatCurrency(currentNotional)}</b>  ⬅  ${formatCurrency(previousNotional)}`];
        return lines.join('\n');
    }

    private getChannelsForBranch(branch: AlertBranch): ChatChannel[] {
        switch (branch) {
            case 'FRESH_WALLET':
                return this.freshWalletChannels;
            case 'WHALE_ACTIVITY':
                return this.whaleActivityChannels;
            case 'BIG_WHALE':
                return this.bigWhaleChannels;
            case 'BIG_TWAP':
                return this.twapChannels;
        }
    }
}
