/**
 * Trade History — in-memory store for closed position records.
 *
 * Records are added when positions are closed via the /build-tx/close endpoint.
 * Also serves as a cache for on-chain closed positions scanned at startup.
 */

export interface TradeRecord {
  wallet: string;
  market: string;         // "SOL-PERP", "BTC-PERP", "ETH-PERP"
  side: "Long" | "Short";
  entryPrice: number;     // USD 6dp
  exitPrice: number;      // USD 6dp
  size: number;           // notional USD
  pnl: number;            // realized PnL USD
  collateralType: string; // "SOL", "JLP", "mSOL"
  closeBps: number;       // 10000 = full, 5000 = 50%
  closedAt: number;       // unix timestamp
  txSig?: string;         // transaction signature if available
}

const MAX_PER_WALLET = 100;
const trades = new Map<string, TradeRecord[]>();

export function recordTrade(record: TradeRecord): void {
  const key = record.wallet;
  let list = trades.get(key);
  if (!list) {
    list = [];
    trades.set(key, list);
  }
  list.unshift(record); // newest first
  if (list.length > MAX_PER_WALLET) list.pop();
}

export function getTradeHistory(wallet: string): TradeRecord[] {
  return trades.get(wallet) || [];
}

export function getAllTradeCount(): number {
  let n = 0;
  for (const v of trades.values()) n += v.length;
  return n;
}
