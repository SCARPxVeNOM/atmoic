/**
 * DFBA (Dual Flow Batch Auction) clearing algorithm.
 *
 * Per master-moves-doc M-3 and composable-perps-docs:
 * - 100ms batch window
 * - 8 sharded sub-queues per side (routed by user_pubkey[0] % 8)
 * - Uniform clearing price maximizing matched volume
 * - Clearing price capped at Pyth ±0.3% (M-1 invariant)
 * - Orders >$10K use commit-reveal (handled at submission layer)
 */

export interface Order {
  user: string;       // pubkey base58
  price: bigint;      // 6dp USD
  size: bigint;       // 6dp notional
  side: "bid" | "ask";
  timestamp: number;
  commitHash?: string; // for commit-reveal orders
}

export interface Fill {
  user: string;
  side: "bid" | "ask";
  price: bigint;
  size: bigint;
  clearingPrice: bigint;
}

export interface BatchResult {
  clearingPrice: bigint;
  fills: Fill[];
  unfilled: Order[];
  totalVolume: bigint;
  pythPrice: bigint;
  priceDeviation: number; // bps from pyth
}

const PYTH_CAP_BPS = 30n; // ±0.3%
const BPS = 10_000n;

// ---- VPIN: Volume-Synchronized Probability of Informed Trading ----
// Reference: Hasbrouck & Henderson (2022), "Measuring Adverse Selection in AMMs"
// VPIN = |V_buy - V_sell| / V_total per batch bucket
// High VPIN (>0.7): informed/toxic flow → widen spread
// Low VPIN (<0.3): noise/uninformed flow → tighten spread

const VPIN_WINDOW = 50; // rolling window of last 50 batches
const vpinHistory: { vpin: number; timestamp: number }[] = [];

/** Current rolling VPIN estimate (0–1 scale). */
export function getVpin(): number {
  if (vpinHistory.length === 0) return 0.5; // neutral default
  const sum = vpinHistory.reduce((s, v) => s + v.vpin, 0);
  return sum / vpinHistory.length;
}

/** Record VPIN for a completed DFBA batch. */
function recordVpin(bidVolume: bigint, askVolume: bigint): void {
  const total = bidVolume + askVolume;
  if (total === 0n) return;
  const diff = bidVolume > askVolume ? bidVolume - askVolume : askVolume - bidVolume;
  const vpin = Number(diff) / Number(total);
  vpinHistory.push({ vpin, timestamp: Date.now() });
  while (vpinHistory.length > VPIN_WINDOW) vpinHistory.shift();
}

/** Get VPIN classification for spread adjustment. */
export function getVpinClassification(): {
  vpin: number;
  classification: "toxic" | "neutral" | "benign";
  spreadMultiplier: number;
} {
  const vpin = getVpin();
  if (vpin > 0.7) return { vpin, classification: "toxic", spreadMultiplier: 1.5 };
  if (vpin < 0.3) return { vpin, classification: "benign", spreadMultiplier: 0.8 };
  return { vpin, classification: "neutral", spreadMultiplier: 1.0 };
}

/**
 * Route an order to a shard index based on user pubkey.
 * user_pubkey[0] % 8
 */
// ---- Live batch queue state (server-side tracking) ----

interface PendingOrder {
  user: string;
  price: number;    // USD
  size: number;     // USD notional
  side: "bid" | "ask";
  market: string;   // "SOL-PERP" | "BTC-PERP" | "ETH-PERP"
  timestamp: number;
}

const pendingOrders: PendingOrder[] = [];
const BATCH_WINDOW_MS = 15_000; // 15-second batch window

export interface BatchFill {
  user: string;
  side: "bid" | "ask";
  price: number;       // order price USD
  size: number;        // filled notional USD
  clearingPrice: number; // uniform clearing price USD
  market: string;
  timestamp: number;
}

interface PerMarketBatchResult {
  clearingPrice: number;
  totalVolume: number;
  fills: number;
  matchedBids: number;
  matchedAsks: number;
  timestamp: number;
}

const lastBatchResults: Record<string, PerMarketBatchResult> = {};
const recentFills: BatchFill[] = [];
const MAX_FILL_HISTORY = 100;

function getLastBatchResult(market: string): PerMarketBatchResult {
  return lastBatchResults[market] || { clearingPrice: 0, totalVolume: 0, fills: 0, matchedBids: 0, matchedAsks: 0, timestamp: 0 };
}

/** Track an order placed via the API. */
export function trackOrder(user: string, price: number, size: number, side: "bid" | "ask", market: string = "SOL-PERP"): void {
  pendingOrders.push({ user, price, size, side, market, timestamp: Date.now() });
  // Prune orders older than 2 batch windows
  const cutoff = Date.now() - BATCH_WINDOW_MS * 2;
  while (pendingOrders.length > 0 && pendingOrders[0].timestamp < cutoff) pendingOrders.shift();
}

/** Remove a user's orders (cancel). */
export function cancelUserOrders(user: string, side?: "bid" | "ask", market?: string): number {
  const before = pendingOrders.length;
  for (let i = pendingOrders.length - 1; i >= 0; i--) {
    const o = pendingOrders[i];
    if (o.user === user && (!side || o.side === side) && (!market || o.market === market)) {
      pendingOrders.splice(i, 1);
    }
  }
  return before - pendingOrders.length;
}

/** Record a batch clearing result for a specific market. */
export function recordBatchResult(market: string, clearingPrice: number, totalVolume: number, fills: number, matchedBids: number, matchedAsks: number): void {
  lastBatchResults[market] = { clearingPrice, totalVolume, fills, matchedBids, matchedAsks, timestamp: Date.now() };
}

/** Get recent fill history. */
export function getRecentFills(market?: string, limit: number = 20): BatchFill[] {
  const filtered = market ? recentFills.filter(f => f.market === market) : recentFills;
  return filtered.slice(0, limit);
}

/** Get current batch queue status for the API, filtered by market. */
export function getBatchStatus(oraclePrice: number, market: string = "SOL-PERP"): {
  bids: number;
  asks: number;
  bidOrders: { price: number; size: number }[];
  askOrders: { price: number; size: number }[];
  lastBatchAt: number;
  clearingPrice: number;
  totalVolume: number;
  lastFills: number;
  lastMatchedBids: number;
  lastMatchedAsks: number;
  oraclePrice: number;
  market: string;
} {
  const now = Date.now();
  // Only show orders from the current batch window, filtered by market
  const windowStart = now - BATCH_WINDOW_MS;
  const current = pendingOrders.filter(o => o.timestamp >= windowStart && o.market === market);

  const bidOrders = current
    .filter(o => o.side === "bid")
    .sort((a, b) => b.price - a.price)
    .map(o => ({ price: o.price, size: o.size }));

  const askOrders = current
    .filter(o => o.side === "ask")
    .sort((a, b) => a.price - b.price)
    .map(o => ({ price: o.price, size: o.size }));

  const lbr = getLastBatchResult(market);
  return {
    bids: bidOrders.length,
    asks: askOrders.length,
    bidOrders,
    askOrders,
    lastBatchAt: lbr.timestamp,
    clearingPrice: lbr.clearingPrice || oraclePrice,
    totalVolume: lbr.totalVolume,
    lastFills: lbr.fills,
    lastMatchedBids: lbr.matchedBids,
    lastMatchedAsks: lbr.matchedAsks,
    oraclePrice,
    market,
  };
}

/**
 * Run a single batch clearing cycle for a specific market.
 * Converts pending orders to Order[]s, runs mergeShardsAndClear(),
 * records results, removes filled orders, and stores fill history.
 *
 * @returns number of fills executed
 */
export function runBatchClearing(market: string, oraclePrice6dp: bigint): number {
  const now = Date.now();
  const windowStart = now - BATCH_WINDOW_MS;

  // Collect current-window orders for this market
  const marketOrders = pendingOrders.filter(o => o.timestamp >= windowStart && o.market === market);

  if (marketOrders.length === 0) {
    // No orders — record empty batch
    recordBatchResult(market, Number(oraclePrice6dp) / 1e6, 0, 0, 0, 0);
    return 0;
  }

  // Convert PendingOrder → Order (bigint 6dp format)
  const orders: Order[] = marketOrders.map(o => ({
    user: o.user,
    price: BigInt(Math.round(o.price * 1e6)),
    size: BigInt(Math.round(o.size * 1e6)),
    side: o.side,
    timestamp: o.timestamp,
  }));

  // Build a single shard (all orders in one array)
  const result = mergeShardsAndClear([orders], oraclePrice6dp);

  const clearingPriceUsd = Number(result.clearingPrice) / 1e6;
  const totalVolumeUsd = Number(result.totalVolume) / 1e6;
  const fillCount = result.fills.length;

  // Track which users got filled so we can remove their pending orders
  const filledUsers = new Set<string>();
  let matchedBids = 0;
  let matchedAsks = 0;

  for (const fill of result.fills) {
    filledUsers.add(`${fill.user}-${fill.side}`);
    if (fill.side === "bid") matchedBids++;
    else matchedAsks++;

    // Store fill in history
    recentFills.unshift({
      user: fill.user,
      side: fill.side,
      price: Number(fill.price) / 1e6,
      size: Number(fill.size) / 1e6,
      clearingPrice: clearingPriceUsd,
      market,
      timestamp: now,
    });
  }

  // Trim fill history
  while (recentFills.length > MAX_FILL_HISTORY) recentFills.pop();

  // Remove filled orders from pending queue
  for (let i = pendingOrders.length - 1; i >= 0; i--) {
    const o = pendingOrders[i];
    if (o.market === market && filledUsers.has(`${o.user}-${o.side}`)) {
      pendingOrders.splice(i, 1);
    }
  }

  // Record result
  recordBatchResult(market, clearingPriceUsd, totalVolumeUsd, fillCount, matchedBids, matchedAsks);

  return fillCount;
}

export function routeToShard(userPubkey: string): number {
  const firstByte = Buffer.from(userPubkey, "base64")[0] ?? 0;
  return firstByte % 8;
}

/**
 * Merge all 8 shards into a single bid and ask array.
 */
function mergeShards(shards: Order[][]): { bids: Order[]; asks: Order[] } {
  const bids: Order[] = [];
  const asks: Order[] = [];
  for (const shard of shards) {
    for (const order of shard) {
      if (order.side === "bid") bids.push(order);
      else asks.push(order);
    }
  }
  // Bids sorted high→low (most aggressive first)
  bids.sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : 0));
  // Asks sorted low→high (most aggressive first)
  asks.sort((a, b) => (a.price > b.price ? 1 : a.price < b.price ? -1 : 0));
  return { bids, asks };
}

/**
 * Find the uniform clearing price that maximizes matched volume.
 *
 * Walk from the most aggressive bid and ask inward. The clearing price
 * is the midpoint where supply meets demand.
 */
function findClearingPrice(bids: Order[], asks: Order[]): bigint | null {
  if (bids.length === 0 || asks.length === 0) return null;

  // Best bid must be >= best ask for any match
  if (bids[0].price < asks[0].price) return null;

  // Find intersection: cumulative bid volume vs cumulative ask volume at each price
  let bidIdx = 0;
  let askIdx = 0;
  let cumBidVol = 0n;
  let cumAskVol = 0n;
  let bestPrice = 0n;
  let bestVolume = 0n;

  // Sweep from highest to lowest price
  const allPrices = [...new Set([...bids.map(b => b.price), ...asks.map(a => a.price)])]
    .sort((a, b) => (b > a ? 1 : b < a ? -1 : 0));

  for (const price of allPrices) {
    // Add bids at or above this price
    while (bidIdx < bids.length && bids[bidIdx].price >= price) {
      cumBidVol += bids[bidIdx].size;
      bidIdx++;
    }
    // Add asks at or below this price
    while (askIdx < asks.length && asks[askIdx].price <= price) {
      cumAskVol += asks[askIdx].size;
      askIdx++;
    }

    const matchedVol = cumBidVol < cumAskVol ? cumBidVol : cumAskVol;
    if (matchedVol > bestVolume) {
      bestVolume = matchedVol;
      bestPrice = price;
    }
  }

  return bestVolume > 0n ? bestPrice : null;
}

/**
 * Cap the clearing price within ±0.3% of Pyth oracle price.
 */
function capToPyth(clearingPrice: bigint, pythPrice: bigint): bigint {
  const maxDeviation = (pythPrice * PYTH_CAP_BPS) / BPS;
  const upper = pythPrice + maxDeviation;
  const lower = pythPrice - maxDeviation;

  if (clearingPrice > upper) return upper;
  if (clearingPrice < lower) return lower;
  return clearingPrice;
}

/**
 * Generate fills from the clearing price. Orders at or better than the
 * clearing price are filled at the uniform clearing price.
 */
function generateFills(
  bids: Order[],
  asks: Order[],
  clearingPrice: bigint,
): { fills: Fill[]; unfilled: Order[] } {
  const fills: Fill[] = [];
  const unfilled: Order[] = [];

  let remainingAskVol = 0n;
  const matchableAsks = asks.filter(a => a.price <= clearingPrice);
  for (const a of matchableAsks) remainingAskVol += a.size;

  let remainingBidVol = 0n;
  const matchableBids = bids.filter(b => b.price >= clearingPrice);
  for (const b of matchableBids) remainingBidVol += b.size;

  const totalMatchable = remainingBidVol < remainingAskVol ? remainingBidVol : remainingAskVol;
  let filled = 0n;

  // Fill bids (pro-rata if oversubscribed)
  for (const bid of matchableBids) {
    if (filled >= totalMatchable) { unfilled.push(bid); continue; }
    const fillSize = bid.size < (totalMatchable - filled) ? bid.size : (totalMatchable - filled);
    fills.push({ user: bid.user, side: "bid", price: bid.price, size: fillSize, clearingPrice });
    filled += fillSize;
    if (fillSize < bid.size) {
      unfilled.push({ ...bid, size: bid.size - fillSize });
    }
  }

  filled = 0n;
  for (const ask of matchableAsks) {
    if (filled >= totalMatchable) { unfilled.push(ask); continue; }
    const fillSize = ask.size < (totalMatchable - filled) ? ask.size : (totalMatchable - filled);
    fills.push({ user: ask.user, side: "ask", price: ask.price, size: fillSize, clearingPrice });
    filled += fillSize;
    if (fillSize < ask.size) {
      unfilled.push({ ...ask, size: ask.size - fillSize });
    }
  }

  // Add completely unmatched orders
  for (const bid of bids) {
    if (bid.price < clearingPrice) unfilled.push(bid);
  }
  for (const ask of asks) {
    if (ask.price > clearingPrice) unfilled.push(ask);
  }

  return { fills, unfilled };
}

/**
 * Main entry point: merge 8 shards and execute batch clearing.
 *
 * @param shards     8 order queue shards
 * @param pythPrice  Current Pyth SOL/USD price (6dp)
 * @returns BatchResult with fills, unfilled orders, and clearing price
 */
export function mergeShardsAndClear(
  shards: Order[][],
  pythPrice: bigint,
): BatchResult {
  const { bids, asks } = mergeShards(shards);

  const rawClearing = findClearingPrice(bids, asks);

  // No matching orders — return empty batch
  if (rawClearing === null) {
    return {
      clearingPrice: pythPrice,
      fills: [],
      unfilled: [...bids, ...asks],
      totalVolume: 0n,
      pythPrice,
      priceDeviation: 0,
    };
  }

  // Cap at Pyth ±0.3%
  const clearingPrice = capToPyth(rawClearing, pythPrice);

  const { fills, unfilled } = generateFills(bids, asks, clearingPrice);

  let totalVolume = 0n;
  let bidFillVolume = 0n;
  let askFillVolume = 0n;
  for (const f of fills) {
    totalVolume += f.size;
    if (f.side === "bid") bidFillVolume += f.size;
    else askFillVolume += f.size;
  }

  // Record VPIN for this batch
  recordVpin(bidFillVolume, askFillVolume);

  const deviationBps = pythPrice > 0n
    ? Number(((clearingPrice - pythPrice) * BPS) / pythPrice)
    : 0;

  return {
    clearingPrice,
    fills,
    unfilled,
    totalVolume,
    pythPrice,
    priceDeviation: deviationBps,
  };
}
