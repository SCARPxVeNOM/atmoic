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

export interface HealthReport {
  collateralValueUsdc: bigint;
  borrowValueUsdc: bigint;
  pnlUsdc: bigint;
  healthFactorBps: bigint;
  liquidatable: boolean;
}

/**
 * Mirror of `calculate_health_factor` in programs/atomic_perps/src/utils/math.rs.
 * Health factor in BPS: 10_000 = exactly at threshold. <10_000 = liquidatable.
 *
 *   health = (collateral_value * threshold_bps) / (borrow_value + |pnl_loss|) * 10_000 / 10_000
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

  // Synthetic perp PnL: (exit - entry) * size / entry, signed by side.
  const entry = position.entryPrice === 0n ? 1n : position.entryPrice;
  const sizeValue = (position.perpSize * solPrice6dp) / solFactor;
  const entryValue = (position.perpSize * entry) / solFactor;
  let pnlUsdc = sizeValue - entryValue;
  if (position.perpSide === Side.Short) pnlUsdc = -pnlUsdc;

  const borrowEffective =
    pnlUsdc >= 0n
      ? position.borrowAmountUsdc
      : position.borrowAmountUsdc + (-pnlUsdc);

  if (borrowEffective === 0n) {
    return {
      collateralValueUsdc,
      borrowValueUsdc: position.borrowAmountUsdc,
      pnlUsdc,
      healthFactorBps: 2n ** 63n - 1n,
      liquidatable: false,
    };
  }

  const healthFactorBps =
    (collateralValueUsdc * liquidationThresholdBps) / borrowEffective;

  return {
    collateralValueUsdc,
    borrowValueUsdc: position.borrowAmountUsdc,
    pnlUsdc,
    healthFactorBps,
    liquidatable: healthFactorBps < 10_000n,
  };
}
