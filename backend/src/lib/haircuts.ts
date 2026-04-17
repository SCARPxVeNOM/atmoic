/**
 * Correlation-Adjusted Haircut System.
 *
 * Per limitations-handbook F-02:
 * - USDC: 0% (stable, uncorrelated)
 * - SOL: 10% (covers flash crash between health checks)
 * - mSOL: 18% (SOL haircut + 8% depeg risk buffer)
 * - JLP: 25% (max IL + correlation with perp losses)
 * - Raydium LP: 35% (worst-case IL at 50% price drop + buffer)
 */

export type CollateralType = "USDC" | "SOL" | "mSOL" | "JLP" | "RAY_LP";

const DEFAULT_HAIRCUTS: Record<CollateralType, number> = {
  USDC: 0,
  SOL: 1000,     // 10% in BPS
  mSOL: 1800,    // 18%
  JLP: 2500,     // 25%
  RAY_LP: 3500,  // 35%
};

const BPS = 10_000;

/** Get haircut in BPS for a collateral type. */
export function getHaircutBps(type: CollateralType): number {
  return DEFAULT_HAIRCUTS[type] ?? 0;
}

/** Get effective value after applying haircut. All values in 6dp. */
export function getEffectiveValue(
  amount: bigint,
  price6dp: bigint,
  type: CollateralType,
): bigint {
  const rawValue = (amount * price6dp) / 1_000_000n;
  const haircut = BigInt(getHaircutBps(type));
  return (rawValue * (BigInt(BPS) - haircut)) / BigInt(BPS);
}

/** Check if a collateral type is yield-bearing (subject to correlation risk). */
export function isYieldBearing(type: CollateralType): boolean {
  return type === "mSOL" || type === "JLP" || type === "RAY_LP";
}

/** Check if collateral type requires liquidation grace period. */
export function requiresGracePeriod(type: CollateralType): boolean {
  return type === "JLP";
}

/** Get grace period duration in milliseconds (0 = no grace period). */
export function getGracePeriodMs(type: CollateralType): number {
  if (type === "JLP") return 2 * 60 * 60 * 1000; // 2 hours
  return 0;
}
