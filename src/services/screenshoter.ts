import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import Logger from '../common/logger';
import { Browser, Page } from 'puppeteer';
import { Proxy } from './proxies';
import { retry } from '../common/utils';
import { createBrowserDir, removeBrowserDir } from '../common/browser-dir';
import { Mutex } from '../common/mutex';
import { config } from '../config';
import { writeDiagnostic } from '../common/diagnostics';

const logger = new Logger('Screenshoter');
puppeteer.use(StealthPlugin());

interface CaptureNetworkDiagnostics {
    started: number;
    finished: number;
    failed: number;
    recentFailures: { url: string; error: string }[];
}

export default class ScreenshotService {
    private browser: Browser | null = null;
    private browserDir: string | null = null;
    private startPromise: Promise<void> | null = null;
    private refCount = 0;
    private readonly captureQueue = new Mutex();

    private static readonly CAPTURE_TIMEOUT_MS = 35_000;
    private static readonly NAVIGATION_TIMEOUT_MS = 20_000;
    private static readonly SELECTOR_TIMEOUT_MS = 10_000;

    private static instance: ScreenshotService | null = null;

    static getInstance(): ScreenshotService {
        if (!ScreenshotService.instance) {
            ScreenshotService.instance = new ScreenshotService();
        }
        ScreenshotService.instance.refCount++;
        return ScreenshotService.instance;
    }

    async start(): Promise<void> {
        if (this.browser?.connected) return;
        if (this.startPromise) return this.startPromise;
        this.browser = null;
        this.startPromise = this.launchBrowser().finally(() => {
            this.startPromise = null;
        });
        return this.startPromise;
    }

    private async launchBrowser(): Promise<void> {
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

        const browserDir = await createBrowserDir();
        this.browserDir = browserDir;

        try {
            this.browser = await puppeteer.launch({
                headless: config.puppeteer.headless,
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
                userDataDir: browserDir,
                args
            });
        } catch (error) {
            this.browserDir = null;
            await removeBrowserDir(browserDir);
            throw error;
        }

        this.browser.on('disconnected', () => {
            this.browser = null;
            if (this.browserDir === browserDir) {
                this.browserDir = null;
                void removeBrowserDir(browserDir);
            }
        });

        logger.info('Puppeteer initialized');
    }

    async stop(): Promise<void> {
        if (this.refCount > 0) this.refCount--;
        if (this.refCount > 0) return;
        await this.shutdown();
    }

    private async shutdown(): Promise<void> {
        const browser = this.browser;
        const browserDir = this.browserDir;
        this.browser = null;
        this.browserDir = null;

        await browser?.close().catch((error) => logger.warn(`Failed to stop Puppeteer cleanly: ${error}`));
        await removeBrowserDir(browserDir);
        if (browser) logger.info('Puppeteer stopped');
    }

    async capture(
        url: string,
        selector?: string,
        waitFn?: () => boolean,
        prehook?: (page: Page) => Promise<void>,
        viewport = { width: 1280, height: 1400 },
        proxy?: Proxy | null
    ): Promise<Buffer | null> {
        const MAX_RETRIES = 1;
        const run = () =>
            retry(
                () => this.captureInternal(url, selector, waitFn, prehook, viewport, proxy),
                { attempts: MAX_RETRIES },
                logger
            );
        if (config.puppeteer.concurrentCaptures) return run();
        return this.captureQueue.runExclusive(run);
    }

    private async captureInternal(
        url: string,
        selector?: string,
        waitFn?: () => boolean,
        prehook?: (page: Page) => Promise<void>,
        viewport?: { width: number; height: number },
        proxy?: Proxy | null
    ): Promise<Buffer | null> {
        let page: Page | null = null;
        let context: Awaited<ReturnType<Browser['createBrowserContext']>> | null = null;
        let captureTimer: NodeJS.Timeout | null = null;
        let captureTimedOut = false;
        const startedAt = Date.now();
        const network: CaptureNetworkDiagnostics = { started: 0, finished: 0, failed: 0, recentFailures: [] };

        try {
            if (!this.browser || !this.browser.connected) await this.start();

            if (proxy) {
                context = await this.browser!.createBrowserContext({
                    proxyServer: `http://${proxy.host}:${proxy.port}`
                });
                page = await context.newPage();
            } else {
                page = await this.browser!.newPage();
            }
            if (!page) throw new Error('Failed to create a new page');

            page.on('request', () => network.started++);
            page.on('requestfinished', () => network.finished++);
            page.on('requestfailed', (request) => {
                network.failed++;
                let resourceUrl = request.url();
                try {
                    const parsed = new URL(resourceUrl);
                    resourceUrl = `${parsed.origin}${parsed.pathname}`;
                } catch {}
                network.recentFailures.push({
                    url: resourceUrl.slice(0, 300),
                    error: request.failure()?.errorText ?? 'unknown'
                });
                if (network.recentFailures.length > 10) network.recentFailures.shift();
            });

            captureTimer = setTimeout(() => {
                captureTimedOut = true;
                void page?.close().catch(() => {});
            }, ScreenshotService.CAPTURE_TIMEOUT_MS);
            captureTimer.unref?.();

            if (proxy)
                await page.authenticate({
                    username: proxy.username,
                    password: proxy.password
                });

            await page.setViewport(viewport!);
            await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }]);
            await page.evaluateOnNewDocument(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => false });
            });

            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: ScreenshotService.NAVIGATION_TIMEOUT_MS });
            await page.waitForSelector('body', { timeout: ScreenshotService.SELECTOR_TIMEOUT_MS });

            if (prehook) await prehook(page);

            if (waitFn) {
                try {
                    await page.waitForFunction(waitFn, {
                        timeout: ScreenshotService.NAVIGATION_TIMEOUT_MS,
                        polling: 1000
                    });
                } catch (err) {
                    const diagnostics = {
                        elapsedMs: Date.now() - startedAt,
                        ...(await this.getPageDiagnostics(page, selector, network))
                    };
                    writeDiagnostic('Screenshoter', 'waitFn-timeout', { url, error: String(err), ...diagnostics });
                    logger.warn(`waitFn timed out for ${url}, capturing current state: ${err}`, diagnostics);
                }
            }

            if (selector) {
                const element = await page.waitForSelector(selector, {
                    timeout: ScreenshotService.SELECTOR_TIMEOUT_MS
                });
                if (!element) throw new Error(`Element not found: ${selector}`);
                const screenshot = await element.screenshot({ type: 'png' });
                return Buffer.from(screenshot);
            }

            const screenshot = await page.screenshot({ type: 'png' });
            return Buffer.from(screenshot);
        } catch (err) {
            const diagnostics = page
                ? {
                      elapsedMs: Date.now() - startedAt,
                      ...(await this.getPageDiagnostics(page, selector, network))
                  }
                : { elapsedMs: Date.now() - startedAt, network };
            if (captureTimedOut) {
                const timeoutError = new Error(
                    `Screenshot capture timed out after ${ScreenshotService.CAPTURE_TIMEOUT_MS}ms`
                );
                writeDiagnostic('Screenshoter', 'capture-timeout', {
                    url,
                    error: timeoutError.message,
                    ...diagnostics
                });
                logger.error(`Screenshot failed for ${url}: ${timeoutError}`, diagnostics);
                throw timeoutError;
            }
            writeDiagnostic('Screenshoter', 'capture-failed', { url, error: String(err), ...diagnostics });
            logger.error(`Screenshot failed for ${url}: ${err}`, diagnostics);
            throw err;
        } finally {
            if (captureTimer) clearTimeout(captureTimer);
            if (page) await page.close().catch(() => {});
            if (context) await context.close().catch(() => {});
        }
    }

    private async getPageDiagnostics(
        page: Page,
        selector: string | undefined,
        network: CaptureNetworkDiagnostics
    ): Promise<Record<string, unknown>> {
        let documentState: Record<string, unknown> | null = null;
        try {
            documentState = await page.evaluate((targetSelector) => {
                const modal = document.querySelector('div[data-modal-card="true"]');
                const navigation = performance.getEntriesByType('navigation')[0] as
                    PerformanceNavigationTiming | undefined;
                return {
                    url: location.href,
                    title: document.title,
                    readyState: document.readyState,
                    visibilityState: document.visibilityState,
                    bodyTextLength: document.body?.innerText.length ?? 0,
                    bodyHtmlLength: document.body?.innerHTML.length ?? 0,
                    bodyTextPreview: document.body?.innerText.replace(/\s+/g, ' ').slice(0, 300) ?? '',
                    selectorFound: targetSelector ? !!document.querySelector(targetSelector) : null,
                    modalFound: !!modal,
                    modalTextLength: modal?.textContent?.length ?? 0,
                    modalLoaderFound: !!modal?.querySelector('[data-testid="component-loader"]'),
                    modalIdFound: !!modal?.querySelector('div.content .id-wrap'),
                    navigation: navigation
                        ? {
                              domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
                              loadMs: Math.round(navigation.loadEventEnd),
                              responseMs: Math.round(navigation.responseEnd),
                              transferredBytes: navigation.transferSize
                          }
                        : null,
                    resourcesLoaded: performance.getEntriesByType('resource').length
                };
            }, selector);
        } catch (error) {
            documentState = { inspectionError: error instanceof Error ? error.message : String(error) };
        }

        return {
            pageUrl: page.url(),
            frames: page
                .frames()
                .map((frame) => frame.url())
                .filter(Boolean),
            document: documentState,
            network: {
                ...network,
                pending: Math.max(0, network.started - network.finished - network.failed)
            }
        };
    }
}
