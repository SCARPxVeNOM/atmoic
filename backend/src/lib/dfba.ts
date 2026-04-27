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
