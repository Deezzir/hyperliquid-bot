import { Browser, Page } from 'puppeteer';
import { config } from '../../config';
import Tg from '../telegram';
import DBService, {
    BetOutcome,
    BetType,
    RacingBetOutcome,
    SportBetOutcome,
    StakeBetDocument,
    StakeBetRecord,
    SwishBetOutcome
} from '../db/stake';
import { ChatChannel, Tracker } from '../../common/tracker';
import { InlineKeyboardMarkup } from 'telegraf/types';
import { capitalize, formatCurrency, sleep } from '../../common/utils';
import { createBrowserDir, removeBrowserDir } from '../../common/browser-dir';
import puppeteer from 'puppeteer-extra';
import { writeDiagnostic } from '../../common/diagnostics';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import ProxyService, { Proxy } from '../proxies';
import { getRedisClient } from '../redis';

interface Payload {
    type: string;
    payload: any;
}

interface Currency {
    name: string;
    rates: {
        currency: string;
        rate: number;
    }[];
}

const commonPayload = `
    fragment BetsBoardSport_BetBet on BetBet {
        __typename
        ... on SwishBet {
            potentialMultiplier
            amount
            currency
            outcomes {
                lineType
                odds
                outcome {
                    line
                    name
                    market {
                        competitor {
                            name
                        }
                        game {
                            status
                            fixture {
                                tournament {
                                    category {
                                        sport {
                                            slug
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        ... on SportBet {
            potentialMultiplier
            amount
            currency
            outcomes {
                odds
                fixtureAbreviation
                outcome {
                    name
                }
                market {
                    name
                }
                fixtureName
                fixture {
                    status
                    tournament {
                        category {
                            sport {
                                slug
                            }
                        }
                    }
                }
            }
        }
        ... on RacingBet {
            betPotentialMultiplier: potentialMultiplier
            amount
            currency
            outcomes {
                type
                prices {
                    marketName
                    odds
                }
                event {
                    status
                    meeting {
                        racing {
                            slug
                        }
                        venue {
                            name
                        }
                    }
                }
                selectionSlots {
                    runners {
                        name
                        runnerNumber
                    }
                }
                result {
                    resultedPrices
                }
            }
        }
    }
`;

const highrollerSportBetsPayload = {
    id: crypto.randomUUID(),
    type: 'subscribe',
    payload: {
        query: `
            subscription BetsBoard_HighrollerSportBets {
                highrollerSportBets {
                    iid
                    bet {
                        ...BetsBoardSport_BetBet
                    }
                }
            }
            ${commonPayload}
    `
    }
};

const allSportBetsPayload = {
    id: crypto.randomUUID(),
    type: 'subscribe',
    payload: {
        query: `
            subscription BetsBoard_AllSportBets {
                allSportBets {
                    iid
                    bet {
                        ...BetsBoardSport_BetBet
                    }
                }
            }
            ${commonPayload}
    `
    }
};

puppeteer.use(StealthPlugin());

export default class StakeService extends Tracker {
    private url = config.stake.url;
    private proxy: Proxy | null = null;

    private page: Page | null = null;
    private browser: Browser | null = null;
    private browserDir: string | null = null;
    private lockdownToken: string | null = null;
    private reconnectingPage = false;
    private betsBatch: Partial<StakeBetDocument>[] = [];
    private betsBatchInterval?: NodeJS.Timeout;

    public constructor(tg: Tg, channels: ChatChannel[], screenshotEnabled = false, useProxy = false) {
        super(tg, channels, screenshotEnabled);
        this.proxy = useProxy ? ProxyService.getRandomProxy() : null;
    }

    async start(): Promise<void> {
        if (this.running) return;
        this.running = true;
        this.logger.info('StakeService monitoring started');

        for (let attempt = 0; attempt < config.stake.retry.maxAttempts && this.running; attempt++) {
            try {
                this.browser = await this.initBrowser();
                this.page = await this.initPage(this.browser);
                await this.cancellableSleep(5000);
                await this.setupPageEventHandlers(this.page);
                this.logger.info(
                    `Puppeteer initialized with${this.proxy ? ` proxy ${this.proxy.host}:${this.proxy.port}` : 'out proxy'}`
                );

                this.betsBatchInterval = setInterval(() => {
                    this.flushBetsBatch().catch((error) => this.logger.error(`Error flushing bets batch: ${error}`));
                }, config.stake.batchFlushIntervalMs);

                await this.subscribeBets();
                this.monitorTask = this.mainLoop();
                return;
            } catch (error) {
                this.clearBatchInterval();
                await this.disposePuppeteer();
                this.logger.error(`Error initializing Puppeteer: ${error}`);

                const nextAttempt = attempt + 1;
                if (nextAttempt >= config.stake.retry.maxAttempts) break;
                const delay = Math.min(
                    config.stake.retry.initialDelayMs *
                        Math.pow(config.stake.retry.backoffMultiplier, Math.max(0, nextAttempt - 1)),
                    config.stake.retry.maxDelayMs
                );
                this.logger.warn(`Retrying Puppeteer initialization in ${Math.round(delay / 1000)}s`);
                await this.cancellableSleep(delay);
            }
        }

        this.running = false;
    }

    async stop(): Promise<void> {
        if (this.running) {
            this.running = false;
            await this.monitorTask?.catch((error) => this.logger.error(`Error while awaiting monitor task: ${error}`));
            this.monitorTask = undefined;
            this.logger.info('Monitoring stopped');
        }

        this.clearBatchInterval();
        await this.flushBetsBatch().catch((error) =>
            this.logger.error(`Error flushing bets batch during stop: ${error}`)
        );
        this.betsBatch = [];

        await Promise.allSettled([this.disposePuppeteer(), this.screenshoter.stop()]);
    }

    private get browserArgs(): string[] {
        const args = [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-gpu',
            '--disable-software-rasterizer',
            '--disable-background-networking',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-sync',
            '--mute-audio',
            '--no-first-run',
            '--no-default-browser-check',
            '--no-zygote'
        ];
        if (!config.puppeteer.headless) args.push('--display=:0');
        if (this.proxy) args.push(`--proxy-server=http://${this.proxy.host}:${this.proxy.port}`);
        return args;
    }

    private clearBatchInterval(): void {
        if (!this.betsBatchInterval) return;
        clearInterval(this.betsBatchInterval);
        this.betsBatchInterval = undefined;
    }

    private async disposePuppeteer(): Promise<void> {
        const page = this.page;
        const browser = this.browser;
        const browserDir = this.browserDir;
        this.page = null;
        this.browser = null;
        this.browserDir = null;

        const closeOps: Promise<unknown>[] = [];
        if (page) closeOps.push(page.close());
        if (browser) closeOps.push(browser.close());
        if (closeOps.length > 0) await Promise.allSettled(closeOps);

        await removeBrowserDir(browserDir);
    }

    private async initBrowser(): Promise<Browser> {
        const configuredDir = config.puppeteer.userDir || null;
        const ephemeralDir = configuredDir ? null : await createBrowserDir();
        this.browserDir = ephemeralDir;

        try {
            return await puppeteer.launch({
                headless: config.puppeteer.headless,
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
                userDataDir: configuredDir ?? ephemeralDir ?? undefined,
                args: this.browserArgs,
                defaultViewport: { width: 1366, height: 768 }
            });
        } catch (error) {
            this.browserDir = null;
            await removeBrowserDir(ephemeralDir);
            throw error;
        }
    }

    private async initPage(browser: Browser): Promise<Page> {
        this.lockdownToken = null;
        const page = await browser.newPage();
        const cdp = await page.createCDPSession();
        await cdp.send('Network.enable');
        cdp.on('Network.webSocketFrameSent', ({ response }) => {
            try {
                const message = JSON.parse(response.payloadData);
                if (message.type === 'connection_init' && message.payload?.lockdownToken) {
                    this.lockdownToken = message.payload.lockdownToken;
                }
            } catch {}
        });
        if (this.proxy)
            await page.authenticate({
                username: this.proxy.username,
                password: this.proxy.password
            });

        await page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        return page;
    }

    private async setupPageEventHandlers(page: Page): Promise<void> {
        await page.exposeFunction('onWSMessage', this.handleMessage.bind(this));
    }

    private async reconnectPage(): Promise<void> {
        if (!this.running || this.reconnectingPage) return;
        this.reconnectingPage = true;
        this.logger.warn('Rebuilding Stake browser session');

        try {
            await this.disposePuppeteer();
            for (let attempt = 0; attempt < config.stake.retry.maxAttempts && this.running; attempt++) {
                try {
                    this.browser = await this.initBrowser();
                    this.page = await this.initPage(this.browser);
                    await this.cancellableSleep(5000);
                    await this.setupPageEventHandlers(this.page);
                    await this.subscribeBets();
                    this.logger.info('Stake browser session rebuilt');
                    return;
                } catch (error) {
                    await this.disposePuppeteer();
                    this.logger.error(`Error rebuilding Stake browser session: ${error}`);
                    const nextAttempt = attempt + 1;
                    if (nextAttempt >= config.stake.retry.maxAttempts) return;
                    const delay = Math.min(
                        config.stake.retry.initialDelayMs *
                            Math.pow(config.stake.retry.backoffMultiplier, Math.max(0, nextAttempt - 1)),
                        config.stake.retry.maxDelayMs
                    );
                    await this.cancellableSleep(delay);
                }
            }
        } finally {
            this.reconnectingPage = false;
        }
    }

    private async mainLoop(): Promise<void> {
        const scanLoop = async () => {
            while (this.running) {
                try {
                    await this.scanAndAlert();
                } catch (error) {
                    this.logger.error(`Error in scanAndAlert: ${error}`);
                }
                if (!this.running) break;
                await this.cancellableSleep(config.monitor.intervalMs);
            }
        };

        const cleanupLoop = async () => {
            while (this.running) {
                try {
                    await DBService.cleanBets(config.stake.cleanupTTLms);
                } catch (error) {
                    this.logger.error(`TradeService.mainLoop cleanup: ${error}`);
                }
                if (!this.running) break;
                await this.cancellableSleep(config.monitor.cleanupIntervalMs);
            }
        };
        await Promise.all([
            scanLoop(),
            cleanupLoop(),
            this.watchDog(config.monitor.noDataTimeoutMs),
            this.scanWatchDog(config.monitor.scanStallTimeoutMs)
        ]);
    }

    private async scanAndAlert(): Promise<void> {
        const candidates = await DBService.getStakeBetsToAlert(config.stake.minAlertBetUSD, config.stake.alertAgeMs);

        this.logger.info(`Found ${candidates.length} candidates needing alert`);
        for (const candidate of candidates) {
            this.lastScanTimestamp = Date.now();
            try {
                await this.processAlertCandidate(candidate);
            } catch (error) {
                this.logger.error(`Failed to alert bet ${candidate.iid}: ${error}`);
            }
        }
        this.lastScanTimestamp = Date.now();
    }

    private setupRestrictedRegionRecovery(page: Page): void {
        page.on('framenavigated', (frame) => {
            if (frame !== page.mainFrame() || !/restrictedRegion|restricted/.test(frame.url())) return;

            const startedAt = Date.now();
            const restrictedUrl = frame.url();
            void (async () => {
                await page.waitForFunction(() => document.readyState === 'complete', { timeout: 5_000 });
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 10_000 }),
                    page.goBack()
                ]);
            })().catch(async (error) => {
                let documentState: unknown = null;
                try {
                    documentState = await page.evaluate(() => ({
                        url: location.href,
                        title: document.title,
                        readyState: document.readyState,
                        bodyTextLength: document.body?.innerText.length ?? 0,
                        bodyTextPreview: document.body?.innerText.replace(/\s+/g, ' ').slice(0, 300) ?? ''
                    }));
                } catch (inspectionError) {
                    documentState = {
                        inspectionError:
                            inspectionError instanceof Error ? inspectionError.message : String(inspectionError)
                    };
                }
                const diagnostics = {
                    elapsedMs: Date.now() - startedAt,
                    restrictedUrl,
                    pageUrl: page.url(),
                    frames: page
                        .frames()
                        .map((currentFrame) => currentFrame.url())
                        .filter(Boolean),
                    document: documentState
                };
                writeDiagnostic('StakeService', 'restricted-region-recovery-failed', {
                    error: String(error),
                    ...diagnostics
                });
                this.logger.warn(`Restricted-region recovery failed: ${error}`, diagnostics);
            });
        });
    }

    private async processAlertCandidate(candidate: StakeBetRecord): Promise<void> {
        this.logger.info(
            `Sending alert for high-value bet: IID ${candidate.iid} ${formatCurrency(candidate.amountUSD)}`
        );
        const result = this.formatAlertMessage(candidate);
        if (!result) return;
        const { msg, buttons } = result;

        let screenshot: Buffer | null = null;
        if (this.screenshotEnabled) {
            try {
                screenshot = await this.screenshoter.capture(
                    `${this.url}/sports/home?iid=${candidate.iid}&modal=bet`,
                    'div[data-modal-card="true"]',
                    () => {
                        const modal = document.querySelector('div[data-modal-card="true"]');
                        if (!modal) return false;
                        if (modal.querySelector('[data-testid="component-loader"]')) return false;
                        return !!modal.querySelector('div.content .id-wrap');
                    },
                    async (page) => this.setupRestrictedRegionRecovery(page),
                    undefined,
                    this.proxy
                );
            } catch (err) {
                this.logger.warn(`Screenshot failed for bet ${candidate.iid}, sending alert without image: ${err}`);
            }
        }

        for (let i = 0; i < this.channels.length; i++) {
            if (i > 0) await sleep(1000);
            const channel = this.channels[i];
            if (screenshot) {
                await this.tg.sendPhoto(channel.chatId, screenshot, msg, {
                    reply_markup: buttons,
                    message_thread_id: channel.topicId
                });
            } else {
                await this.tg.sendMessage(channel.chatId, msg, {
                    reply_markup: buttons,
                    message_thread_id: channel.topicId
                });
            }
        }
        await DBService.markAlerted(candidate.id);
    }

    private getEventDetails(type: BetType, outcomes: BetOutcome[]): string[] {
        const lines: string[] = [];
        switch (type) {
            case 'SwishBet':
                for (const outcome of outcomes as SwishBetOutcome[]) {
                    lines.push(`${outcome.event.live ? '🔴 LIVE' : '⏱️ PREMATCH'}`);
                    lines.push(`Sport: ${outcome.event.sport}`);
                    lines.push(`Competitor: ${outcome.event.competitor}`);
                    lines.push(
                        `${capitalize(outcome.event.lineType)} ${outcome.event.lineValue} - ${outcome.event.lineName}`
                    );
                    lines.push(`Odds: ${outcome.odds.toFixed(2)}`);
                    lines.push('');
                }
                break;
            case 'SportBet':
                for (const outcome of outcomes as SportBetOutcome[]) {
                    lines.push(`${outcome.event.live ? '🔴 LIVE' : '⏱️ PREMATCH'}`);
                    lines.push(`<b>${outcome.event.name} (${outcome.event.abbreviation})</b>`);
                    lines.push(`Sport: ${capitalize(outcome.event.sport)}`);
                    lines.push(`Outcome: ${outcome.event.outcome} (${outcome.event.market})`);
                    lines.push('');
                }
                break;
            case 'RacingBet':
                for (const outcome of outcomes as RacingBetOutcome[]) {
                    lines.push(`${outcome.event.live ? '🔴 LIVE' : '⏱️ PREMATCH'}`);
                    lines.push(`Sport: ${capitalize(outcome.event.sport)}`);
                    lines.push(`Venue: ${outcome.event.venue}`);
                    lines.push(`Runners:`);
                    for (const runner of outcome.event.runners) {
                        lines.push(` - ${runner.name} (#${runner.number !== null ? runner.number : 'N/A'})`);
                    }
                    lines.push(`Odds:`);
                    for (const odd of outcome.event.odds) {
                        lines.push(` - ${odd.type}: ${odd.odds.toFixed(2)}`);
                    }
                    lines.push('');
                }
                break;
            default:
                return [];
        }
        return lines;
    }

    private formatAlertMessage(candidate: StakeBetRecord): {
        msg: string;
        buttons: InlineKeyboardMarkup;
    } | null {
        const amount = formatCurrency(candidate.amountUSD);
        const multiplier = candidate.potentialMultiplier || 0;
        const potentialWin = formatCurrency(multiplier * candidate.amountUSD);
        const eventDetails = this.getEventDetails(candidate.type, candidate.outcomes);
        const header = candidate.amountUSD >= 250_000 ? '🚀 <b>HUGE BET</b> 🚀' : '💎 <b>HIGHROLLER</b> 💎';

        const lines = [
            `${header}`,
            '',
            `<b>Size:</b> <code>${amount}</code>`,
            `<b>Multiplier:</b> <code>${multiplier.toFixed(2)}x</code>`,
            `<b>Potential Win:</b> <code>${potentialWin}</code>`,
            '',
            candidate.outcomes.length > 1 ? `🎯 <b>EXPRESS</b> 🎯` : `🎯 <b>SINGLE</b> 🎯`,
            '',
            ...eventDetails
        ];
        return {
            msg: lines.join('\n'),
            buttons: {
                inline_keyboard: [
                    [
                        {
                            text: '🔗 View on Stake.com',
                            url: `${this.url}/sports/home?iid=${candidate.iid}&modal=bet`
                        }
                    ]
                ]
            }
        };
    }

    private async fetchCurrencies(): Promise<Map<string, number>> {
        const stakeCurrenciesKey = 'stake:currencies';
        const redis = getRedisClient();

        const cached = await redis.get(stakeCurrenciesKey);
        if (cached) return new Map(JSON.parse(cached));

        if (!this.page) throw new Error('Puppeteer page is not initialized');

        const currencies = await this.page.evaluate(async (api: string) => {
            const res = await fetch(api, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: `query CurrencyConfiguration($isAcp: Boolean!) {
                                currencyConfiguration(isAcp: $isAcp) {
                                    currencies {
                                        name
                                        rates {
                                            currency
                                            rate
                                        }
                                    }
                                }
                            }`,
                    variables: { isAcp: false }
                })
            });
            const data = await res.json();
            return data.data.currencyConfiguration.currencies as Currency[];
        }, config.stake.api);

        const rateMap = new Map<string, number>();
        for (const currency of currencies) {
            const usd = currency.rates.find((r) => r.currency === 'usd');
            if (!usd) continue;
            rateMap.set(currency.name, usd.rate);
        }
        await redis.setEx(stakeCurrenciesKey, config.monitor.cacheTTLMs / 1000, JSON.stringify([...rateMap]));
        return rateMap;
    }

    private async subscribeBets(): Promise<void> {
        if (!this.page) throw new Error('Puppeteer page is not initialized');

        const allSportsPayload = allSportBetsPayload;
        const highrollerPayload = highrollerSportBetsPayload;
        const startPayload = {
            type: 'connection_init',
            payload: {
                language: 'en',
                ...(this.lockdownToken ? { lockdownToken: this.lockdownToken } : {})
            }
        };
        const wssUrl = config.stake.wss;
        const retry = config.stake.retry;

        await this.page.evaluate(
            (
                wssUrl: string,
                startPayload: Payload,
                allSportsPayload: Payload,
                highrollerPayload: Payload,
                retry: { initialDelayMs: number; backoffMultiplier: number; maxDelayMs: number }
            ) => {
                const log = (message: string, level: 'info' | 'error' | 'warn' = 'info') => {
                    (window as any).onWSMessage(
                        JSON.stringify({
                            type: 'log',
                            level,
                            message
                        })
                    );
                };

                if (!(window as any).stakeWSManager) {
                    (window as any).stakeWSManager = {};
                }
                const manager = (window as any).stakeWSManager;

                const subscriptions = [allSportsPayload, highrollerPayload];

                const clearPing = () => {
                    if (manager.pingInterval) {
                        clearInterval(manager.pingInterval);
                        manager.pingInterval = null;
                    }
                };

                const clearReconnectTimer = () => {
                    if (manager.reconnectTimer) {
                        clearTimeout(manager.reconnectTimer);
                        manager.reconnectTimer = null;
                    }
                };

                const clearAcknowledgementTimeout = () => {
                    if (manager.acknowledgementTimeout) {
                        clearTimeout(manager.acknowledgementTimeout);
                        manager.acknowledgementTimeout = null;
                    }
                };

                const closeSocket = (silent = false) => {
                    const ws = manager.ws as WebSocket | null;
                    if (!ws) return;
                    if (silent) {
                        ws.onopen = null;
                        ws.onmessage = null;
                        ws.onerror = null;
                        ws.onclose = null;
                    }
                    try {
                        ws.close();
                    } catch {}
                    manager.ws = null;
                };

                const scheduleReconnect = (reason: string) => {
                    if (manager.reconnectTimer) return;

                    const nextAttempt = Number(manager.reconnectAttempts ?? 0) + 1;
                    manager.reconnectAttempts = nextAttempt;

                    const delay = Math.min(
                        retry.initialDelayMs * Math.pow(retry.backoffMultiplier, Math.max(0, nextAttempt - 1)),
                        retry.maxDelayMs
                    );

                    log(
                        `WebSocket reconnecting in ${Math.round(delay / 1000)}s (attempt ${nextAttempt}, reason: ${reason})`,
                        'warn'
                    );

                    manager.reconnectTimer = setTimeout(() => {
                        manager.reconnectTimer = null;
                        connect();
                    }, delay);
                };

                const connect = () => {
                    clearPing();
                    clearReconnectTimer();
                    closeSocket(true);

                    const ws = new WebSocket(wssUrl, 'graphql-transport-ws');
                    manager.ws = ws;

                    ws.onopen = () => {
                        manager.reconnectAttempts = 0;
                        log('WebSocket connected', 'info');
                        ws.send(JSON.stringify(startPayload));
                        manager.acknowledgementTimeout = setTimeout(() => {
                            log('WebSocket connection acknowledgement timed out', 'warn');
                            (window as any).onWSMessage(JSON.stringify({ type: 'session_expired' }));
                            ws.close();
                        }, 10_000);
                        manager.pingInterval = setInterval(() => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'ping' }));
                            }
                        }, 15000);
                    };

                    ws.onmessage = (event: MessageEvent<string>) => {
                        let data: { type?: string };
                        try {
                            data = JSON.parse(String(event.data)) as { type?: string };
                        } catch {
                            return;
                        }

                        if (data.type === 'connection_ack') {
                            clearAcknowledgementTimeout();
                            log('WebSocket connection acknowledged', 'info');
                            for (const subscription of subscriptions) ws.send(JSON.stringify(subscription));
                            return;
                        }
                        if (data.type === 'ping') {
                            ws.send(JSON.stringify({ type: 'pong' }));
                            return;
                        }
                        if (data.type === 'pong') return;

                        (window as any).onWSMessage(String(event.data));
                    };

                    ws.onerror = (err: Event) => {
                        log(`WebSocket error: ${err.type}`, 'error');
                        try {
                            ws.close();
                        } catch {}
                    };

                    ws.onclose = (event: CloseEvent) => {
                        if (manager.ws !== ws) return;

                        manager.ws = null;
                        clearPing();
                        clearAcknowledgementTimeout();

                        log(`WebSocket closed (code=${event.code}, reason=${event.reason || 'none'}).`, 'warn');

                        if (event.code === 4401 || event.code === 4403) {
                            (window as any).onWSMessage(JSON.stringify({ type: 'session_expired' }));
                            return;
                        }
                        scheduleReconnect(`close:${event.code}`);
                    };
                };

                clearReconnectTimer();
                closeSocket(true);
                manager.reconnectAttempts = 0;
                connect();
            },
            wssUrl,
            startPayload,
            allSportsPayload,
            highrollerPayload,
            retry
        );
    }

    private handleBrowserLog(log: any): void {
        if (!log.type || log.type !== 'log' || !log.message) return;
        switch (log.level) {
            case 'info':
                this.logger.info(`${log.message}`);
                break;
            case 'warn':
                this.logger.warn(`${log.message}`);
                break;
            case 'error':
                this.logger.error(`${log.message}`);
                break;
            default:
                this.logger.info(`${log.message}`);
        }
    }

    private async handleMessage(message: any): Promise<void> {
        const MIN_BET_USD = 1_000;

        try {
            const parsed = JSON.parse(message);
            if (parsed.type === 'log') {
                this.handleBrowserLog(parsed);
                return;
            }
            if (parsed.type === 'session_expired') {
                await this.reconnectPage();
                return;
            }
            if (parsed.type !== 'next') return;

            const betData = parsed.payload?.data?.allSportBets || parsed.payload?.data?.highrollerSportBets;
            if (!betData?.bet) return;

            const betRaw = betData.bet;
            const outcomes: BetOutcome[] = betRaw.outcomes.map((o: any) => {
                let outcome: SwishBetOutcome | SportBetOutcome | RacingBetOutcome;
                switch (betRaw.__typename) {
                    case 'SwishBet':
                        outcome = {
                            odds: o.odds ?? 0,
                            event: {
                                live: o?.outcome?.market?.game?.fixture?.status === 'live',
                                sport:
                                    o?.outcome?.market?.game?.fixture?.tournament?.category?.sport?.slug ?? 'unknown',
                                competitor: o?.outcome?.market?.competitor?.name ?? 'unknown',
                                lineType: o?.lineType ?? 'unknown',
                                lineValue: o?.outcome?.line ?? 0,
                                lineName: o?.outcome?.name ?? 'unknown'
                            }
                        } satisfies SwishBetOutcome;
                        break;
                    case 'RacingBet':
                        outcome = {
                            event: {
                                live: o?.event?.status === 'live',
                                type: o?.type ?? 'unknown',
                                sport: o?.event?.meeting?.racing?.slug ?? 'unknown',
                                venue: o?.event?.meeting?.venue?.name ?? 'unknown',
                                runners: [],
                                odds: []
                            }
                        } satisfies RacingBetOutcome;
                        if (Array.isArray(o.prices)) {
                            for (const price of o.prices) {
                                outcome.event.odds.push({
                                    odds: price?.odds ?? 0,
                                    type: price?.marketName ?? 'unknown'
                                });
                            }
                        }
                        if (Array.isArray(o.selectionSlots)) {
                            for (const slot of o.selectionSlots) {
                                for (const runner of slot.runners ?? []) {
                                    outcome.event.runners.push({
                                        name: runner?.name ?? 'unknown',
                                        number: runner?.runnerNumber ?? null
                                    });
                                }
                            }
                        }
                        break;
                    case 'SportBet':
                        outcome = {
                            odds: o.odds ?? 0,
                            event: {
                                live: o?.fixture?.status === 'live',
                                sport: o?.fixture?.tournament?.category?.sport?.slug ?? 'unknown',
                                name: o?.fixtureName ?? 'unknown',
                                abbreviation: o?.fixtureAbreviation ?? 'unknown',
                                outcome: o?.outcome?.name ?? 'unknown',
                                market: o?.market?.name ?? 'unknown'
                            }
                        } satisfies SportBetOutcome;
                        break;
                    default:
                        outcome = {} as any;
                }
                return outcome;
            });

            const amountUSD = await (async () => {
                const currencyRates = await this.fetchCurrencies();
                const rate = currencyRates.get(betRaw.currency);
                if (!rate) return 0;
                return betRaw.amount * rate;
            })();

            if (amountUSD < MIN_BET_USD) return;

            await this.handleBet({
                type: betRaw.__typename,
                potentialMultiplier: betRaw.potentialMultiplier ?? betRaw.betPotentialMultiplier ?? null,
                amountUSD,
                iid: betData.iid,
                outcomes
            });
        } catch (err) {
            this.logger.error(`Error parsing message: ${err}`);
        }
    }

    private async handleBet(bet: Partial<StakeBetDocument>): Promise<void> {
        this.betsBatch.push(bet);
        if (this.betsBatch.length >= config.stake.batchSize) this.flushBetsBatch();
    }

    private async flushBetsBatch(): Promise<void> {
        await this.flushMutex.runExclusive(async () => {
            if (this.betsBatch.length === 0) return;
            const batchToFlush = [...this.betsBatch];
            this.betsBatch = [];
            this.lastDataTimestamp = Date.now();

            const seenIids = new Set<string>();
            const uniqueBets = batchToFlush.filter((bet) => {
                if (!bet.iid || seenIids.has(bet.iid)) return false;
                seenIids.add(bet.iid);
                return true;
            });
            if (uniqueBets.length === 0) return;

            try {
                this.logger.info(`Flushing bets batch of size ${uniqueBets.length}`);
                await DBService.addStakeBetsBulk(uniqueBets);
            } catch (error) {
                this.logger.error(`Error flushing bets batch: ${error}`);
            }
        });
    }
}
