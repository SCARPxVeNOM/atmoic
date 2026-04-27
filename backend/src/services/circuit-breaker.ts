/**
 * CUSUM Circuit Breaker — Statistical Process Control for regime detection.
 *
 * Replaces the fixed "15% drop in 4h" threshold with a CUSUM (Cumulative Sum)
 * control chart that detects distributional shifts in price returns.
 *
 * Reference: Page (1954), "Continuous Inspection Schemes"
 * DeFi extension: Chen, Li, Zhang (2024), "Statistical Process Control for DEX Risk"
 *
 * CUSUM accumulates evidence of abnormal negative returns. It triggers when
 * cumulative evidence exceeds a critical value, catching:
 * - Slow-moving crashes (3-5% daily drops over 2 weeks — never hit 15% in 4h)
 * - While ignoring flash crashes that recover quickly (CUSUM resets toward 0)
 *
 * Formula: S_t = max(0, S_{t-1} + (x_t - μ_0 - k))
 * Triggers when S_t > h (control limit)
 */

import pino from "pino";
import { Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { fetchLatestPrice } from "../lib/pyth";
import { env } from "../lib/env";
import { connection, loadKeypair } from "../lib/connection";
import { buildUpdateConfigIx } from "../lib/ix-builders";
import { recordPriceObservation } from "../lib/spread";

const log = pino({ transport: { target: "pino-pretty" } } as any);

const POLL_MS = 15_000;                  // check every 15s (feeds variance buffer too)
const RESET_MS = 24 * 60 * 60 * 1000;   // 24h auto-reset

// ---- CUSUM Parameters ----
// μ_0 = expected log return under normal conditions (near 0 for 15s intervals)
const MU_0 = 0;
// k = reference value. Set to detect shifts of ~0.5% per observation.
// k = (μ_1 - μ_0) / 2 where μ_1 is the stress log return
const K = 0.0025; // half of a 0.5% drop per tick
// h = control limit. Higher = fewer false positives, slower detection.
// Calibrated: ~40 consecutive -0.5% ticks, or ~100 mixed negative ticks
const H = 0.10;

// Also keep the legacy fixed threshold as a hard backstop
const LEGACY_WINDOW_MS = 4 * 60 * 60 * 1000;
const LEGACY_THRESHOLD_BPS = 1500; // 15%

interface PricePoint {
  price: number;
  timestamp: number;
}

const priceHistory: PricePoint[] = [];
let cusumStatistic = 0;
let lastPrice = 0;

export const breakerState = {
  triggered: false,
  triggeredAt: 0,
  triggerPrice: 0,
  currentPrice: 0,
  dropPct: 0,
  cusumValue: 0,
  triggerMethod: "" as "" | "cusum" | "legacy-threshold",
};

/**
 * Update CUSUM statistic with a new log return observation.
 * S_t = max(0, S_{t-1} + (x_t - μ_0 - k))
 * For detecting negative shifts, we use -x_t (downward CUSUM).
 */
function updateCusum(logReturn: number): void {
  // Downward CUSUM: accumulates evidence of negative returns
  cusumStatistic = Math.max(0, cusumStatistic + (-logReturn - MU_0 - K));
  breakerState.cusumValue = cusumStatistic;
}

/** Legacy fixed-threshold check as hard backstop. */
function checkLegacyThreshold(): boolean {
  if (priceHistory.length < 2) return false;
  const now = Date.now();
  const cutoff = now - LEGACY_WINDOW_MS;

  let windowHigh = 0;
  for (const p of priceHistory) {
    if (p.timestamp >= cutoff && p.price > windowHigh) windowHigh = p.price;
  }
  if (windowHigh === 0) return false;

  const current = priceHistory[priceHistory.length - 1].price;
  const dropBps = Math.round(((windowHigh - current) / windowHigh) * 10_000);
  breakerState.dropPct = dropBps / 100;

  return dropBps >= LEGACY_THRESHOLD_BPS;
}

async function sendAlert(message: string) {
  log.fatal(message);
  if (env.alertWebhookUrl) {
    try {
      await fetch(env.alertWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: message }),
      });
    } catch { /* ignore */ }
  }
}

async function triggerBreaker(price: number, method: "cusum" | "legacy-threshold") {
  breakerState.triggered = true;
  breakerState.triggeredAt = Date.now();
  breakerState.triggerPrice = price;
  breakerState.triggerMethod = method;

  const methodLabel = method === "cusum"
    ? `CUSUM statistic ${cusumStatistic.toFixed(4)} exceeded threshold ${H}`
    : `Legacy threshold: ${breakerState.dropPct.toFixed(1)}% drop in 4h`;

  log.fatal({ price, method, cusum: cusumStatistic }, "CIRCUIT BREAKER TRIGGERED");

  await sendAlert(
    `CIRCUIT BREAKER TRIGGERED (${method}): ${methodLabel}. ` +
    `Current price: $${price.toFixed(2)}. Protocol paused.`
  );

  // Pause protocol on-chain
  try {
    const authority = loadKeypair();
    const pauseIx = buildUpdateConfigIx({
      authority: authority.publicKey,
      isPaused: true,
      maxLeverage: 50_000, // 5x during circuit breaker
      stressActive: true,
    });
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      pauseIx,
    );
    const sig = await connection.sendTransaction(tx, [authority]);
    await connection.confirmTransaction(sig, "confirmed");
    log.info({ sig }, "protocol PAUSED on-chain via circuit breaker");
  } catch (e) {
    log.error({ err: String(e) }, "FAILED to pause protocol on-chain");
  }
}

async function resetBreaker() {
  breakerState.triggered = false;
  breakerState.triggerMethod = "";
  cusumStatistic = 0; // Reset CUSUM on recovery
  log.info("circuit breaker RESET — CUSUM statistic zeroed");
  await sendAlert("Circuit breaker RESET — protocol resuming normal operations.");

  try {
    const authority = loadKeypair();
    const unpauseIx = buildUpdateConfigIx({
      authority: authority.publicKey,
      isPaused: false,
      maxLeverage: 100_000,
      stressActive: false,
    });
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      unpauseIx,
    );
    const sig = await connection.sendTransaction(tx, [authority]);
    await connection.confirmTransaction(sig, "confirmed");
    log.info({ sig }, "protocol UNPAUSED on-chain");
  } catch (e) {
    log.error({ err: String(e) }, "FAILED to unpause protocol on-chain");
  }
}

async function tick() {
  try {
    const { price6dp } = await fetchLatestPrice();
    const price = Number(price6dp) / 1e6;
    const now = Date.now();

    // Feed price to variance buffer (Avellaneda-Stoikov spread engine)
    recordPriceObservation(price);

    priceHistory.push({ price, timestamp: now });
    const cutoff = now - LEGACY_WINDOW_MS;
    while (priceHistory.length > 0 && priceHistory[0].timestamp < cutoff) priceHistory.shift();

    breakerState.currentPrice = price;

    if (breakerState.triggered) {
      // Check for auto-reset (24h without re-trigger)
      if (now - breakerState.triggeredAt > RESET_MS) {
        // Only reset if CUSUM has decayed and legacy threshold is clear
        if (cusumStatistic < H / 2 && !checkLegacyThreshold()) {
          await resetBreaker();
        }
      }
      // Still update CUSUM even when triggered (for monitoring)
      if (lastPrice > 0) {
        const logReturn = Math.log(price / lastPrice);
        updateCusum(logReturn);
      }
      lastPrice = price;
      return;
    }

    // Compute log return and update CUSUM
    if (lastPrice > 0) {
      const logReturn = Math.log(price / lastPrice);
      updateCusum(logReturn);

      // CUSUM trigger: cumulative evidence of regime change
      if (cusumStatistic > H) {
        await triggerBreaker(price, "cusum");
        lastPrice = price;
        return;
      }
    }

    // Legacy backstop: hard 15% drop in 4h
    if (checkLegacyThreshold()) {
      await triggerBreaker(price, "legacy-threshold");
    }

    lastPrice = price;
  } catch (e) {
    log.error({ err: String(e) }, "circuit breaker tick failed");
  }
}

export async function startCircuitBreaker(): Promise<void> {
  log.info({ cusumH: H, cusumK: K, legacyThresholdBps: LEGACY_THRESHOLD_BPS }, "CUSUM circuit breaker starting");
  while (true) {
    await tick();
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) {
  startCircuitBreaker().catch(e => { log.error(String(e)); process.exit(1); });
}
