import mongoose, { Document, Schema } from 'mongoose';
import Logger from '../../common/logger';

const logger = new Logger('HyperliquidDB');

const TRADE_SNAPSHOT_CAP = 500;

export type HyperTradeDirection = 'long' | 'short' | 'spot_buy' | 'spot_sell';

export function isSpotDirection(direction: HyperTradeDirection): boolean {
    return direction === 'spot_buy' || direction === 'spot_sell';
}

export interface TradeSnapshot {
    ts: number;
    size: number;
}

interface HyperAggregationDocument extends Document {
    wallet: string;
    coin: string;
    dateKey: string;
    direction: HyperTradeDirection;
    totalNotional: number;
    tradeCount: number;
    lastTradeTime: number;
    trades?: TradeSnapshot[];
}

export type HyperAggregationRecord = Omit<HyperAggregationDocument, keyof Document> & {
    id: string;
};

const HyperAggregationSchema = new Schema<HyperAggregationDocument>(
    {
        wallet: { type: String, required: true },
        coin: { type: String, required: true },
        dateKey: { type: String, required: true },
        direction: { type: String, required: true, enum: ['long', 'short', 'spot_buy', 'spot_sell'] },
        totalNotional: { type: Number, default: 0 },
        tradeCount: { type: Number, default: 0 },
        lastTradeTime: { type: Number, default: 0 },
        trades: { type: [{ ts: Number, size: Number }], default: [] }
    },
    { timestamps: true }
);

HyperAggregationSchema.index({ wallet: 1, coin: 1, dateKey: 1, direction: 1 }, { unique: true });
HyperAggregationSchema.index({ dateKey: 1, totalNotional: -1 });
HyperAggregationSchema.index({ updatedAt: 1 });

const HyperAggregationModel =
    mongoose.models.WalletAggregation ||
    mongoose.model<HyperAggregationDocument>('HyperAggregation', HyperAggregationSchema);

// Hyperliquid tracked wallets schema
interface HyperTrackedDocument extends Document {
    wallet: string;
    coin: string;
    totalNotional: number;
    direction: HyperTradeDirection;
    lastCheckedAt: number;
    nextCheckAt?: number;
}

export type HyperTrackedRecord = Omit<HyperTrackedDocument, keyof Document> & {
    id: string;
};

const HyperTrackedSchema = new Schema<HyperTrackedDocument>(
    {
        wallet: { type: String, required: true, unique: true },
        coin: { type: String, required: true },
        totalNotional: { type: Number, default: 0 },
        direction: { type: String, required: true, enum: ['long', 'short', 'spot_buy', 'spot_sell'] },
        lastCheckedAt: { type: Number, default: 0 },
        nextCheckAt: { type: Number }
    },
    { timestamps: true }
);

HyperTrackedSchema.index({ wallet: 1, coin: 1, direction: 1 }, { unique: true });
HyperTrackedSchema.index({ nextCheckAt: 1 });

const HyperTrackedModel =
    mongoose.models.WalletTracking || mongoose.model<HyperTrackedDocument>('HyperTrack', HyperTrackedSchema);

interface HyperAlert {
    wallet: string;
    coin: string;
    totalNotional: number;
    direction: HyperTradeDirection;
    branch?: string;
    sentAt: Date;
    chatId: number;
    messageId?: number;
}

interface HyperAlertDocument extends HyperAlert, Document {}

const HyperAlertSchema = new Schema<HyperAlertDocument>(
    {
        wallet: { type: String, required: true },
        coin: { type: String, required: true },
        direction: { type: String, required: true, enum: ['long', 'short', 'spot_buy', 'spot_sell'] },
        branch: { type: String, enum: ['FRESH_WALLET', 'WHALE_ACTIVITY', 'BIG_WHALE', 'BIG_TWAP'], required: false },
        totalNotional: { type: Number, required: true },
        sentAt: { type: Date, required: true },
        chatId: { type: Number, required: true },
        messageId: { type: Number }
    },
    { timestamps: true }
);

HyperAlertSchema.index({ wallet: 1, coin: 1, direction: 1, branch: 1, chatId: 1 });
HyperAlertSchema.index({ wallet: 1, coin: 1, direction: 1, branch: 1, chatId: 1, sentAt: -1 });
HyperAlertSchema.index({ sentAt: 1 });

const HyperAlertModel =
    mongoose.models.HyperAlert || mongoose.model<HyperAlertDocument>('HyperAlert', HyperAlertSchema);

export type HyperTradeRecord = {
    wallet: string;
    coin: string;
    notional: number;
    tradeTime: number;
    direction: HyperTradeDirection;
};

export interface PositionKey {
    wallet: string;
    coin: string;
    direction: HyperTradeDirection;
}

export default class HyperliquidDBService {
    private static formatDateKey(timestamp: number, windowMs?: number): string {
        if (!windowMs) {
            return new Date(timestamp).toISOString().slice(0, 10);
        }
        const bucketStart = Math.floor(timestamp / windowMs) * windowMs;
        return new Date(bucketStart).toISOString();
    }

    static async isWalletTracked(wallet: string, coin: string, direction: HyperTradeDirection): Promise<boolean> {
        try {
            const doc = await HyperTrackedModel.findOne({ wallet, coin, direction }).lean().exec();
            return doc !== null;
        } catch (error) {
            logger.error(`Error checking tracked wallet ${wallet}: ${error}`);
            throw error;
        }
    }

    static async addUpdateTrackedWallet(
        wallet: string,
        coin: string,
        direction: HyperTradeDirection,
        totalNotional: number,
        checkInterval?: number
    ): Promise<void> {
        try {
            await HyperTrackedModel.updateOne(
                { wallet, coin, direction },
                {
                    $set: {
                        lastCheckedAt: Date.now(),
                        nextCheckAt: checkInterval ? Date.now() + checkInterval : 0,
                        totalNotional: totalNotional
                    }
                },
                { upsert: true }
            );
        } catch (error) {
            logger.error(`Error adding tracked wallet ${wallet}: ${error}`);
            throw error;
        }
    }

    static async getTrackedWallets(): Promise<HyperTrackedRecord[]> {
        try {
            const docs = await HyperTrackedModel.find().lean().exec();
            return docs.map((doc) => ({
                id: String(doc._id),
                wallet: doc.wallet,
                coin: doc.coin,
                totalNotional: doc.totalNotional,
                direction: doc.direction,
                lastCheckedAt: doc.lastCheckedAt,
                nextCheckAt: doc.nextCheckAt
            }));
        } catch (error) {
            logger.error(`Error retrieving tracked wallets: ${error}`);
            throw error;
        }
    }

    static async getTradeById(id: string): Promise<HyperAggregationRecord | null> {
        try {
            const doc = await HyperAggregationModel.findOne({ _id: new mongoose.Types.ObjectId(id) })
                .lean<HyperAggregationRecord>()
                .exec();
            return doc;
        } catch (error) {
            logger.error(`Error retrieving trade with id ${id}: ${error}`);
            throw error;
        }
    }

    static async addTradesBulk(trades: HyperTradeRecord[], windowMs?: number): Promise<boolean> {
        try {
            const aggregated = new Map<
                string,
                {
                    filter: { wallet: string; coin: string; dateKey: string; direction: HyperTradeDirection };
                    totalNotional: number;
                    tradeCount: number;
                    lastTradeTime: number;
                    trades: TradeSnapshot[];
                }
            >();

            for (const trade of trades) {
                const dateKey = this.formatDateKey(trade.tradeTime, windowMs);
                const key = `${trade.wallet}:${trade.coin}:${trade.direction}:${dateKey}`;
                const existing = aggregated.get(key);

                if (existing) {
                    existing.totalNotional += trade.notional;
                    existing.tradeCount += 1;
                    existing.lastTradeTime = Math.max(existing.lastTradeTime, trade.tradeTime);
                    existing.trades.push({ ts: trade.tradeTime, size: trade.notional });
                    continue;
                }

                const trades_: TradeSnapshot[] = [{ ts: trade.tradeTime, size: trade.notional }];

                aggregated.set(key, {
                    filter: { wallet: trade.wallet, coin: trade.coin, dateKey, direction: trade.direction },
                    totalNotional: trade.notional,
                    tradeCount: 1,
                    lastTradeTime: trade.tradeTime,
                    trades: trades_
                });
            }

            const bulkOps = Array.from(aggregated.values()).map((entry) => {
                const update: any = {
                    $inc: {
                        totalNotional: entry.totalNotional,
                        tradeCount: entry.tradeCount
                    },
                    $set: {
                        lastTradeTime: entry.lastTradeTime
                    }
                };
                if (entry.trades.length > 0) {
                    update.$push = { trades: { $each: entry.trades, $slice: -TRADE_SNAPSHOT_CAP } };
                }
                return {
                    updateOne: {
                        filter: entry.filter,
                        update,
                        upsert: true,
                        setDefaultsOnInsert: true
                    }
                };
            });

            if (bulkOps.length === 0) return true;

            const start = performance.now();
            const result = await HyperAggregationModel.bulkWrite(bulkOps, { ordered: false });
            logger.debug(
                `addTradesBulk: ${trades.length} trades aggregated to ${bulkOps.length} ops in ${(performance.now() - start).toFixed(1)}ms`
            );
            return result.ok === 1;
        } catch (error) {
            logger.error(`Error inserting trade batch: ${error}`);
            throw error;
        }
    }

    static async addTrade(trade: HyperTradeRecord, windowMs?: number): Promise<HyperAggregationRecord> {
        try {
            const dateKey = this.formatDateKey(trade.tradeTime, windowMs);
            const doc = await HyperAggregationModel.findOneAndUpdate(
                { wallet: trade.wallet, coin: trade.coin, dateKey, direction: trade.direction },
                {
                    $inc: {
                        totalNotional: trade.notional,
                        tradeCount: 1
                    },
                    $set: {
                        lastTradeTime: trade.tradeTime
                    }
                },
                {
                    new: true,
                    upsert: true,
                    setDefaultsOnInsert: true
                }
            );

            if (!doc) {
                throw new Error('Failed to record wallet aggregation');
            }

            return {
                id: String(doc._id),
                wallet: doc.wallet,
                coin: doc.coin,
                dateKey: doc.dateKey,
                direction: doc.direction as HyperTradeDirection,
                totalNotional: doc.totalNotional,
                tradeCount: doc.tradeCount,
                lastTradeTime: doc.lastTradeTime
            };
        } catch (error) {
            logger.error(`Error recording trade for wallet ${trade.wallet}: ${error}`);
            throw error;
        }
    }

    static async getExpiredTrackedWallets(): Promise<HyperTrackedRecord[]> {
        try {
            const start = performance.now();
            const docs = await HyperTrackedModel.find({ nextCheckAt: { $lte: Date.now() } })
                .lean()
                .exec();
            logger.debug(
                `getExpiredTrackedWallets: ${docs.length} results in ${(performance.now() - start).toFixed(1)}ms`
            );
            return docs.map((doc) => ({
                id: String(doc._id),
                wallet: doc.wallet,
                coin: doc.coin,
                totalNotional: doc.totalNotional,
                direction: doc.direction,
                lastCheckedAt: doc.lastCheckedAt,
                nextCheckAt: doc.nextCheckAt
            }));
        } catch (error) {
            logger.error(`Error retrieving expired tracked wallets: ${error}`);
            throw error;
        }
    }

    static async removeTrackedWallet(
        wallet: string,
        coin: string,
        direction: HyperTradeDirection
    ): Promise<HyperTrackedRecord | null> {
        try {
            const deleted = await HyperTrackedModel.findOneAndDelete({
                wallet,
                coin,
                direction
            });

            if (deleted) {
                logger.info(`Removed tracked wallet ${wallet} / ${coin} / ${direction}`);
            }

            return deleted;
        } catch (error) {
            logger.error(`Error removing tracked wallet ${wallet}: ${error}`);
            return null;
        }
    }

    static async removeTrackedWalletById(id: string): Promise<HyperTrackedRecord | null> {
        try {
            const deleted = await HyperTrackedModel.findByIdAndDelete(id);

            if (deleted) logger.info(`Removed tracked wallet with id ${id}`);
            return deleted;
        } catch (error) {
            logger.error(`Error removing tracked wallet with id ${id}: ${error}`);
            return null;
        }
    }

    static async getTradesToAlert(
        keysToScan: PositionKey[],
        threshold: number,
        windowMs?: number
    ): Promise<HyperAggregationRecord[]> {
        try {
            const dateKey = this.formatDateKey(Date.now(), windowMs);
            if (keysToScan.length === 0) return [];

            const start = performance.now();
            const docs = await HyperAggregationModel.find(
                {
                    dateKey,
                    totalNotional: { $gte: threshold },
                    $or: keysToScan.map((k) => ({ wallet: k.wallet, coin: k.coin, direction: k.direction }))
                },
                {
                    wallet: 1,
                    coin: 1,
                    dateKey: 1,
                    direction: 1,
                    totalNotional: 1,
                    tradeCount: 1,
                    lastTradeTime: 1,
                    trades: 1
                }
            )
                .lean()
                .exec();
            logger.debug(
                `getTradesToAlert: ${keysToScan.length} keys, ${docs.length} results in ${(performance.now() - start).toFixed(1)}ms`
            );

            return docs.map((doc) => ({
                id: String(doc._id),
                wallet: doc.wallet,
                coin: doc.coin,
                dateKey: doc.dateKey,
                direction: doc.direction as HyperTradeDirection,
                totalNotional: doc.totalNotional,
                tradeCount: doc.tradeCount,
                lastTradeTime: doc.lastTradeTime,
                trades: (doc as any).trades || []
            }));
        } catch (error) {
            logger.error(`${error}`);
            throw error;
        }
    }

    static async updateTradeNotional(id: string, newNotional: number): Promise<void> {
        try {
            await HyperAggregationModel.updateOne(
                { _id: new mongoose.Types.ObjectId(id) },
                { $set: { totalNotional: newNotional } }
            ).exec();
        } catch (error) {
            logger.error(`Error updating notional for trade ${id}: ${error}`);
            throw error;
        }
    }

    static async cleanTrades(ttlMs: number): Promise<void> {
        try {
            const cutoffDate = new Date(Date.now() - ttlMs);
            const result = await HyperAggregationModel.deleteMany({ updatedAt: { $lt: cutoffDate } });
            logger.info(`Deleted ${result.deletedCount} old aggregation records`);
        } catch (error) {
            logger.error(`${error}`);
            throw error;
        }
    }

    static async cleanAlerts(ttlMs: number): Promise<void> {
        try {
            const cutoffDate = new Date(Date.now() - ttlMs);
            const result = await HyperAlertModel.deleteMany({ sentAt: { $lt: cutoffDate } });
            logger.info(`Deleted ${result.deletedCount} old alert records`);
        } catch (error) {
            logger.error(`${error}`);
            throw error;
        }
    }

    static async getLastAlerts(
        wallet: string,
        coin: string,
        direction: HyperTradeDirection,
        chatIds: number[],
        branch?: string
    ): Promise<Map<number, HyperAlert>> {
        if (chatIds.length === 0) return new Map();
        try {
            const start = performance.now();
            const matchFilter: any = { wallet, coin, direction, chatId: { $in: chatIds } };
            if (branch) matchFilter.branch = branch;
            const docs = await HyperAlertModel.aggregate<{ _id: number; doc: HyperAlert }>([
                { $match: matchFilter },
                { $sort: { sentAt: -1 } },
                { $group: { _id: '$chatId', doc: { $first: '$$ROOT' } } }
            ]);
            logger.debug(
                `getLastAlerts: wallet=${wallet}, ${docs.length} results in ${(performance.now() - start).toFixed(1)}ms`
            );
            const result = new Map<number, HyperAlert>();
            for (const { _id, doc } of docs) {
                result.set(_id, doc);
            }
            return result;
        } catch (error) {
            logger.error(`Error retrieving last alerts for wallet ${wallet}: ${error}`);
            throw error;
        }
    }

    static async insertAlert(alert: HyperAlert): Promise<void> {
        try {
            await HyperAlertModel.create(alert);
        } catch (error) {
            logger.error(`Error inserting alert for wallet ${alert.wallet}: ${error}`);
            throw error;
        }
    }
}
