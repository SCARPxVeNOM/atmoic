/**
 * JLP (Jupiter Liquidity Provider) price fetcher.
 *
 * Per limitations-handbook A-04: always fetch live JLP virtual price.
 * Never use stored prices for health calculation.
 * JLP collateral gets 25% haircut.
 *
 * Uses Jupiter Price API v3 instead of raw pool account parsing
 * (the on-chain pool account has a complex Anchor layout).
 */

const JLP_MINT = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";

export interface JlpPrice {
  /** Virtual price per JLP token in USD (6dp). */
  virtualPrice6dp: bigint;
  /** USD price as a float (for logging). */
  usdPrice: number;
}

let cache: { data: JlpPrice; ts: number } | null = null;
const CACHE_MS = 10_000; // 10s cache

/**
 * Fetch the live JLP price from Jupiter Price API v3.
 */
export async function fetchJlpPrice(): Promise<JlpPrice> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_MS) return cache.data;

  const url = `https://api.jup.ag/price/v3?ids=${JLP_MINT}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter Price API error: ${res.status}`);

  const body = await res.json();
  const entry = body[JLP_MINT];
  if (!entry || !entry.usdPrice) {
    throw new Error("JLP price not available from Jupiter");
  }

  const usdPrice = Number(entry.usdPrice);
  // Convert to 6dp integer (e.g. $3.92 -> 3_920_000)
  const virtualPrice6dp = BigInt(Math.round(usdPrice * 1e6));

  const data: JlpPrice = { virtualPrice6dp, usdPrice };
  cache = { data, ts: now };
  return data;
}

/**
 * Compute JLP collateral value with 25% haircut.
 * Per limitations-handbook: JLP haircut = 25% (max IL + correlation losses)
 */
export function jlpCollateralValue(amount: bigint, virtualPrice6dp: bigint): bigint {
  const rawValue = (amount * virtualPrice6dp) / 1_000_000n;
  // Apply 25% haircut (keep 75%)
  return (rawValue * 7_500n) / 10_000n;
}
