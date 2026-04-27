/**
 * Avellaneda-Stoikov Dynamic Spread Engine.
 *
 * The vault acts as a market maker with inventory risk. The spread is
 * mathematically derived from the Avellaneda-Stoikov optimal market-making
 * model (2008, Operations Research).
 *
 * Key formulas (adapted for perps vault):
 *   Reservation price:  r = s - q * γ * σ² * (T - t)
 *   Optimal spread:     δ = γ * σ² * (T - t) + (2/γ) * ln(1 + γ/k)
 *
 * Where all quantities are in PRICE UNITS (USD), not log-return space:
 *   s = mid price (Pyth oracle, USD)
 *   q = inventory in base asset units (net SOL exposure from vault fills)
 *   γ = risk aversion (USD⁻¹) — calibrated so γ*s ≈ 0.01 for typical prices
 *   σ² = price variance (USD²/second) — from rolling price observations
 *   T - t = time remaining in trading session (seconds)
 *   k = order arrival rate (orders/second)
 *
 * Reference: Avellaneda & Stoikov, "High-frequency trading in a limit order book"
 */

import { GlobalConfigData } from "./decode";

export interface SpreadResult {
  spreadBps: number;
  skewPct: number;
  suspended: boolean;
  blockedSide?: "long" | "short";
  /** Reservation price offset in bps (+ = vault prefers to sell) */
  reservationOffsetBps: number;
  /** Bid-side spread from mid price in bps */
  bidSpreadBps: number;
  /** Ask-side spread from mid price in bps */
  askSpreadBps: number;
  model: "avellaneda-stoikov" | "static-fallback";
}

// ---- Price observation ring buffer (feeds σ² computation) ----
const VARIANCE_WINDOW = 120;
const priceObservations: { price: number; ts: number }[] = [];

/** Feed a new USD price observation. Called from circuit-breaker tick (~15s). */
export function recordPriceObservation(price: number): void {
  priceObservations.push({ price, ts: Date.now() });
  if (priceObservations.length > VARIANCE_WINDOW) priceObservations.shift();
}

/**
 * Compute price variance in USD²/second.
 *
 * We compute the variance of price CHANGES (ΔP) per unit time,
 * not log returns. This keeps dimensions consistent with A-S.
 *
 * Var(ΔP/Δt) ≈ Σ(ΔP_i²) / (n * Δt)
 */
function computePriceVariance(): number {
  if (priceObservations.length < 10) return 0.01; // default: $0.1²/s
  let sumSq = 0;
  let count = 0;
  for (let i = 1; i < priceObservations.length; i++) {
    const dt = (priceObservations[i].ts - priceObservations[i - 1].ts) / 1000; // seconds
    if (dt <= 0) continue;
    const dp = priceObservations[i].price - priceObservations[i - 1].price;
    sumSq += (dp * dp) / dt; // USD²/second for this interval
    count++;
  }
  if (count < 5) return 0.01;
  return Math.max(sumSq / count, 0.0001); // USD²/second, floored
}

/** Get last observed price. */
function getLastPrice(): number {
  if (priceObservations.length === 0) return 100; // fallback
  return priceObservations[priceObservations.length - 1].price;
}

// ---- DFBA batch fill rate tracking ----
const recentBatchFills: number[] = [];
const FILL_RATE_WINDOW_MS = 10 * 60 * 1000;

export function recordBatchFill(): void {
  recentBatchFills.push(Date.now());
  const cutoff = Date.now() - FILL_RATE_WINDOW_MS;
  while (recentBatchFills.length > 0 && recentBatchFills[0] < cutoff) recentBatchFills.shift();
}

function estimateArrivalRate(): number {
  if (recentBatchFills.length < 2) return 0.1;
  const elapsed = (recentBatchFills[recentBatchFills.length - 1] - recentBatchFills[0]) / 1000;
  return elapsed > 0 ? recentBatchFills.length / elapsed : 0.1;
}

// ---- A-S Parameters ----
// γ calibrated so that γ * midPrice ≈ 0.01 (dimensionless risk factor)
// For SOL at ~$85: γ ≈ 0.01 / 85 ≈ 0.000118
// We compute γ dynamically from the current price.
const GAMMA_FACTOR = 0.01; // γ = GAMMA_FACTOR / midPrice
const T_SESSION = 28800;   // 8h session in seconds
const MIN_SPREAD_BPS = 5;
const MAX_SPREAD_BPS = 200;

/**
 * Avellaneda-Stoikov spread computation with correct dimensional analysis.
 *
 * 1. γ = GAMMA_FACTOR / s  (units: 1/USD)
 * 2. σ² in USD²/second
 * 3. Reservation offset = q * γ * σ² * τ  (units: USD × 1/USD × USD²/s × s = USD)
 * 4. Spread = γ * σ² * τ + (2/γ) * ln(1 + γ/k) (units: USD)
 * 5. Convert to bps: spread_bps = (spread / s) * 10000
 */
export function evaluateVaultRisk(config: GlobalConfigData): SpreadResult {
  const longOi = Number(config.totalLongOi);
  const shortOi = Number(config.totalShortOi);
  const totalOi = longOi + shortOi;

  const diff = Math.abs(longOi - shortOi);
  const skewPct = totalOi > 0 ? Math.round((diff * 100) / totalOi) : 0;

  // Suspension at extreme skew (>90%)
  if (skewPct > 90 && totalOi > 0) {
    const blockedSide = longOi > shortOi ? "long" as const : "short" as const;
    return {
      spreadBps: 0, skewPct, suspended: true, blockedSide,
      reservationOffsetBps: 0, bidSpreadBps: 0, askSpreadBps: 0,
      model: "static-fallback",
    };
  }

  const s = getLastPrice(); // mid price in USD
  if (s <= 0) {
    return {
      spreadBps: MIN_SPREAD_BPS, skewPct, suspended: false,
      reservationOffsetBps: 0, bidSpreadBps: MIN_SPREAD_BPS, askSpreadBps: MIN_SPREAD_BPS,
      model: "static-fallback",
    };
  }

  // γ = GAMMA_FACTOR / s (units: 1/USD)
  const gamma = GAMMA_FACTOR / s;

  // q = normalized inventory in "equivalent base asset units"
  // Positive q = vault is net long (exposed to price drops)
  // Scale: q = (longOi - shortOi) / s  to get "SOL-equivalent" inventory
  const q = totalOi > 0 ? (longOi - shortOi) / s : 0;

  // σ² in USD²/second
  const sigma2 = computePriceVariance();

  // τ = time remaining in session (seconds)
  const now = Date.now() / 1000;
  const tau = Math.max(T_SESSION - (now % T_SESSION), 60);

  // k = order arrival rate (orders/second)
  const k = estimateArrivalRate();

  // ---- Reservation price offset (USD) ----
  // r = s - q * γ * σ² * τ
  // offset = -q * γ * σ² * τ  (positive = vault prefers to sell)
  const offsetUsd = -q * gamma * sigma2 * tau;

  // ---- Optimal half-spread (USD) ----
  // δ/2 = (γ * σ² * τ)/2 + (1/γ) * ln(1 + γ/k)
  const halfSpreadUsd = (gamma * sigma2 * tau) / 2 + (1 / gamma) * Math.log(1 + gamma / k);

  // ---- Convert to BPS relative to mid price ----
  const offsetBps = Math.round((offsetUsd / s) * 10000);
  const halfSpreadBps = Math.round((halfSpreadUsd / s) * 10000);

  // Asymmetric spread: bid side wider when vault is long, ask side wider when short
  const bidBps = Math.max(MIN_SPREAD_BPS, halfSpreadBps + offsetBps);
  const askBps = Math.max(MIN_SPREAD_BPS, halfSpreadBps - offsetBps);
  const totalBps = Math.max(bidBps, askBps);

  return {
    spreadBps: Math.max(MIN_SPREAD_BPS, Math.min(MAX_SPREAD_BPS, totalBps)),
    skewPct,
    suspended: false,
    reservationOffsetBps: Math.max(-100, Math.min(100, offsetBps)),
    bidSpreadBps: Math.min(MAX_SPREAD_BPS, bidBps),
    askSpreadBps: Math.min(MAX_SPREAD_BPS, askBps),
    model: "avellaneda-stoikov",
  };
}

/**
 * Apply spread to a notional amount.
 */
export function applySpread(notionalAmount: bigint, spreadBps: number): {
  adjustedAmount: bigint;
  spreadFee: bigint;
} {
  const fee = (notionalAmount * BigInt(spreadBps)) / 10_000n;
  return {
    adjustedAmount: notionalAmount - fee,
    spreadFee: fee,
  };
}
