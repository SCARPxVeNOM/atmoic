import { fetchJlpPrice } from "./jlp";
import { fetchMsolPrice } from "./msol";

const JLP_MINT = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";
const MSOL_MINT = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";

export interface YieldInfo {
  collateralType: string;
  currentApy: number;
  rate8h: number;
  rate8hBps: number;
}

// Cache yield data for 60 seconds
let cache: { data: Map<string, YieldInfo>; ts: number } = { data: new Map(), ts: 0 };
const CACHE_TTL = 60_000;

/**
 * Get yield rate for a collateral type.
 * JLP yield: estimated from Jupiter pool APY (~20-30% APY).
 * mSOL yield: from Marinade staking ratio (~7% APY).
 * SOL: 0% (no native yield).
 */
export async function getCollateralYield(
  collMint: string,
  solPrice6dp: bigint,
): Promise<YieldInfo> {
  if (Date.now() - cache.ts < CACHE_TTL && cache.data.has(collMint)) {
    return cache.data.get(collMint)!;
  }

  let info: YieldInfo;

  if (collMint === JLP_MINT) {
    try {
      const jlp = await fetchJlpPrice();
      // JLP APY estimated at ~25% (conservative). Actual varies.
      // More accurate: track price appreciation over time.
      const apy = 25.0;
      const rate8h = apy / (365 * 3); // 3 funding periods per day
      const rate8hBps = Math.round(rate8h * 100);
      info = { collateralType: "JLP", currentApy: apy, rate8h, rate8hBps };
    } catch {
      info = { collateralType: "JLP", currentApy: 20.0, rate8h: 20 / (365 * 3), rate8hBps: 2 };
    }
  } else if (collMint === MSOL_MINT) {
    try {
      const msol = await fetchMsolPrice(solPrice6dp);
      // mSOL APY from stake ratio appreciation (~7%)
      const apy = (msol.stakeRatio - 1.0) * 100 * 0.95; // rough estimate
      const effectiveApy = Math.max(5.0, Math.min(10.0, apy || 7.0));
      const rate8h = effectiveApy / (365 * 3);
      const rate8hBps = Math.round(rate8h * 100);
      info = { collateralType: "mSOL", currentApy: effectiveApy, rate8h, rate8hBps };
    } catch {
      info = { collateralType: "mSOL", currentApy: 7.0, rate8h: 7 / (365 * 3), rate8hBps: 1 };
    }
  } else {
    info = { collateralType: "SOL", currentApy: 0, rate8h: 0, rate8hBps: 0 };
  }

  cache.data.set(collMint, info);
  cache.ts = Date.now();
  return info;
}

/**
 * Compute the net funding rate for a position after yield offset.
 * Returns the effective rate in BPS that should be passed to settle_funding.
 */
export function computeNetFundingBps(
  rawFundingBps: number,
  yieldBps8h: number,
): { netBps: number; selfRepaying: boolean } {
  const netBps = rawFundingBps - yieldBps8h;
  return {
    netBps: Math.max(-100, Math.min(100, Math.round(netBps))),
    selfRepaying: netBps < 0,
  };
}
