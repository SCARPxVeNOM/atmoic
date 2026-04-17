/**
 * Collateral TVL Cap Enforcement.
 *
 * Per limitations-handbook F-02:
 * - JLP + mSOL combined ≤ 30% of total platform collateral
 * - At least 70% must be USDC or SOL (uncorrelated)
 */

import { CollateralType, isYieldBearing } from "./haircuts";

const MAX_YIELD_BEARING_PCT = 30; // 30% cap for JLP + mSOL + RAY_LP

export interface CollateralTotals {
  USDC: bigint;
  SOL: bigint;
  mSOL: bigint;
  JLP: bigint;
  RAY_LP: bigint;
}

export interface CapCheckResult {
  allowed: boolean;
  currentYieldPct: number;
  afterYieldPct: number;
  reason?: string;
}

/**
 * Check if a new deposit would violate the collateral cap.
 *
 * @param depositType  Type of collateral being deposited
 * @param depositValue Value in USD (6dp) of the new deposit
 * @param totals       Current collateral totals by type (USD value, 6dp)
 */
export function checkCollateralCap(
  depositType: CollateralType,
  depositValue: bigint,
  totals: CollateralTotals,
): CapCheckResult {
  const currentTotal = totals.USDC + totals.SOL + totals.mSOL + totals.JLP + totals.RAY_LP;
  const currentYield = totals.mSOL + totals.JLP + totals.RAY_LP;
  const newTotal = currentTotal + depositValue;

  let newYield = currentYield;
  if (isYieldBearing(depositType)) {
    newYield += depositValue;
  }

  const currentYieldPct = currentTotal > 0n
    ? Number((currentYield * 100n) / currentTotal)
    : 0;
  const afterYieldPct = newTotal > 0n
    ? Number((newYield * 100n) / newTotal)
    : 0;

  if (afterYieldPct > MAX_YIELD_BEARING_PCT) {
    return {
      allowed: false,
      currentYieldPct,
      afterYieldPct,
      reason: `Yield-bearing collateral would be ${afterYieldPct}% of TVL (max ${MAX_YIELD_BEARING_PCT}%)`,
    };
  }

  return { allowed: true, currentYieldPct, afterYieldPct };
}
