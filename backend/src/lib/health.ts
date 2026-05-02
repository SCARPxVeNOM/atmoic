import { PositionData, Side } from "./decode";
import { CollateralType, getHaircutBps } from "./haircuts";

export interface HealthInput {
  position: PositionData;
  solPrice6dp: bigint;
  liquidationThresholdBps: bigint;
  solDecimals?: number;
  /** Collateral type for haircut calculation. Default: SOL. */
  collateralType?: CollateralType;
  /** For JLP: price at position open (used as floor). */
  entryCollateralPrice6dp?: bigint;
}

export type DeleverageZone = "safe" | "zone1" | "zone2" | "zone3" | "full";

export interface HealthReport {
  collateralValueUsdc: bigint;
  /** Notional position size in USD (was borrowValueUsdc in lending model). */
  notionalUsdc: bigint;
  pnlUsdc: bigint;
  /** Effective margin = collateral value + unrealized PnL. */
  effectiveMarginUsdc: bigint;
  /** Margin ratio in BPS: effective_margin / notional * 10000. */
  marginRatioBps: bigint;
  healthFactorBps: bigint;
  liquidatable: boolean;
  /** Gradual deleveraging zone. */
  deleverageZone: DeleverageZone;
  /** Percentage that would be closed if liquidated now: 0, 25, 50, 75, or 100. */
  deleveragePct: number;
}

/** Maintenance margin: 5% (500 bps). Matches on-chain MAINTENANCE_MARGIN_BPS. */
const MAINTENANCE_MARGIN_BPS = 500n;

/**
 * Compute health for a perps position using margin ratio model.
 *
 * margin_ratio = effective_margin / notional
 * effective_margin = collateral_value + unrealized_pnl
 * Liquidatable when margin_ratio < MAINTENANCE_MARGIN_BPS / 10000
 */
export function computeHealth({
  position,
  solPrice6dp,
  liquidationThresholdBps,
  solDecimals = 9,
  collateralType = "SOL",
  entryCollateralPrice6dp,
}: HealthInput): HealthReport {
  const solFactor = 10n ** BigInt(solDecimals);

  // For JLP: use max(entry_price, current_price) as floor (A-04)
  let effectivePrice = solPrice6dp;
  if (collateralType === "JLP" && entryCollateralPrice6dp) {
    effectivePrice = solPrice6dp > entryCollateralPrice6dp ? solPrice6dp : entryCollateralPrice6dp;
  }

  const rawCollateralValue = (position.collateralAmount * effectivePrice) / solFactor;

  // Apply haircut per collateral type
  const haircutBps = BigInt(getHaircutBps(collateralType));
  const collateralValueUsdc = (rawCollateralValue * (10_000n - haircutBps)) / 10_000n;

  // Synthetic perp PnL — power-aware: standard (p=1) or squeeth (p=2).
  const entry = position.entryPrice === 0n ? 1n : position.entryPrice;
  const power = position.powerMilli ?? 0n;
  const pnlUsdc = (() => {
    const p = (power === 0n || power === 1000n) ? 1000n : power;

    if (p === 2000n) {
      // Squeeth: pnl = (exit² - entry²) / entry² * size, signed by side
      const exitSq = solPrice6dp * solPrice6dp;
      const entrySq = entry * entry;
      if (entrySq === 0n) return 0n;
      const delta = exitSq > entrySq ? exitSq - entrySq : entrySq - exitSq;
      const absVal = (delta * position.perpSize) / entrySq;
      const rawPositive = exitSq >= entrySq;
      const isProfit = position.perpSide === Side.Long ? rawPositive : !rawPositive;
      return isProfit ? absVal : -absVal;
    }

    // Standard: (exit - entry) * size / entry
    const priceDelta = position.perpSide === Side.Short
      ? entry - solPrice6dp
      : solPrice6dp - entry;
    return (priceDelta * position.perpSize) / entry;
  })();

  // Effective margin = collateral value + unrealized PnL
  const effectiveMarginUsdc = collateralValueUsdc + pnlUsdc;

  // Notional = borrow_amount_usdc (repurposed as notional in perps model)
  const notionalUsdc = position.borrowAmountUsdc;

  // Margin ratio in BPS: effective_margin / notional * 10000
  const marginRatioBps = notionalUsdc === 0n
    ? 2n ** 63n - 1n
    : (effectiveMarginUsdc * 10_000n) / notionalUsdc;

  // Gradual deleveraging zone classification
  const deleverageZone: DeleverageZone =
    marginRatioBps >= MAINTENANCE_MARGIN_BPS ? "safe" :
    marginRatioBps >= 400n ? "zone1" :
    marginRatioBps >= 300n ? "zone2" :
    marginRatioBps >= 200n ? "zone3" : "full";

  const deleveragePct =
    deleverageZone === "safe" ? 0 :
    deleverageZone === "zone1" ? 25 :
    deleverageZone === "zone2" ? 50 :
    deleverageZone === "zone3" ? 75 : 100;

  return {
    collateralValueUsdc,
    notionalUsdc,
    pnlUsdc,
    effectiveMarginUsdc,
    marginRatioBps,
    healthFactorBps: marginRatioBps, // alias for backward compat
    liquidatable: marginRatioBps < MAINTENANCE_MARGIN_BPS,
    deleverageZone,
    deleveragePct,
  };
}
