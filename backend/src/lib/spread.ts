/**
 * Dynamic Spread Engine (M-2 from master-moves-doc).
 *
 * Computes vault skew from on-chain GlobalConfig and applies tiered
 * spread that widens as the vault becomes one-sided. Fills are
 * suspended at extreme skew (>90%) to prevent vault insolvency.
 */

import { GlobalConfigData } from "./decode";

export interface SpreadResult {
  spreadBps: number;
  skewPct: number;
  suspended: boolean;
}

/**
 * Evaluate vault risk based on current OI skew.
 *
 * In Phase 1, we approximate skew from totalUsdcBorrowed vs totalUsdcReserve.
 * Once on-chain OI tracking lands (Sprint 4), this will use long_oi / short_oi.
 *
 * Spread tiers (from limitations-handbook):
 *   0-30%  skew → 5 bps
 *   31-55% skew → 15 bps
 *   56-75% skew → 40 bps
 *   76-90% skew → 100 bps
 *   90%+   skew → fills SUSPENDED
 */
export function evaluateVaultRisk(config: GlobalConfigData): SpreadResult {
  const borrowed = Number(config.totalUsdcBorrowed);
  const reserve = Number(config.totalUsdcReserve);
  const total = borrowed + reserve;

  if (total === 0) {
    return { spreadBps: 5, skewPct: 0, suspended: false };
  }

  // Skew = how utilized the vault is (borrowed / total capacity)
  const skewPct = Math.round((borrowed * 100) / total);

  if (skewPct > 90) {
    return { spreadBps: 0, skewPct, suspended: true };
  }
  if (skewPct > 75) {
    return { spreadBps: 100, skewPct, suspended: false };
  }
  if (skewPct > 55) {
    return { spreadBps: 40, skewPct, suspended: false };
  }
  if (skewPct > 30) {
    return { spreadBps: 15, skewPct, suspended: false };
  }
  return { spreadBps: 5, skewPct, suspended: false };
}

/**
 * Apply spread to a borrow amount. Returns the adjusted borrow amount
 * the user receives after the spread fee is deducted.
 */
export function applySpread(borrowAmount: bigint, spreadBps: number): {
  adjustedBorrow: bigint;
  spreadFee: bigint;
} {
  const fee = (borrowAmount * BigInt(spreadBps)) / 10_000n;
  return {
    adjustedBorrow: borrowAmount - fee,
    spreadFee: fee,
  };
}
