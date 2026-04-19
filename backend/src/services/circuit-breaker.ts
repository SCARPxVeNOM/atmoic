/**
 * Circuit Breaker Service — auto-pauses protocol on extreme price drops.
 *
 * Per limitations-handbook F-02 and master-moves M-2:
 * - Triggers when SOL drops >15% in any 4-hour window
 * - Actions: widen spread to 500bps, reduce leverage to 5x, alert team
 * - Auto-resets after 24h without re-trigger
 */

import pino from "pino";
import { Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { fetchLatestPrice } from "../lib/pyth";
import { env } from "../lib/env";
import { connection, loadKeypair } from "../lib/connection";
import { buildUpdateConfigIx } from "../lib/ix-builders";

const log = pino({ transport: { target: "pino-pretty" } } as any);

const WINDOW_MS = 4 * 60 * 60 * 1000; // 4 hours
const RESET_MS = 24 * 60 * 60 * 1000;  // 24 hours
const POLL_MS = 30_000;                 // check every 30s

interface PricePoint {
  price: number;
  timestamp: number;
}

const priceHistory: PricePoint[] = [];

export const breakerState = {
  triggered: false,
  triggeredAt: 0,
  triggerPrice: 0,
  currentPrice: 0,
  dropPct: 0,
};

function checkTrigger(thresholdBps: number): boolean {
  if (priceHistory.length < 2) return false;
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  // Find highest price in the window
  let windowHigh = 0;
  for (const p of priceHistory) {
    if (p.timestamp >= cutoff && p.price > windowHigh) windowHigh = p.price;
  }
  if (windowHigh === 0) return false;

  const current = priceHistory[priceHistory.length - 1].price;
  const dropBps = Math.round(((windowHigh - current) / windowHigh) * 10_000);
  breakerState.currentPrice = current;
  breakerState.dropPct = dropBps / 100;

  return dropBps >= thresholdBps;
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

async function tick() {
  try {
    const { price6dp } = await fetchLatestPrice();
    const price = Number(price6dp) / 1e6;
    const now = Date.now();

    priceHistory.push({ price, timestamp: now });
    // Trim old history
    const cutoff = now - WINDOW_MS;
    while (priceHistory.length > 0 && priceHistory[0].timestamp < cutoff) priceHistory.shift();

    if (breakerState.triggered) {
      // Check for auto-reset (24h without re-trigger)
      if (now - breakerState.triggeredAt > RESET_MS && !checkTrigger(env.circuitBreakerThresholdBps)) {
        breakerState.triggered = false;
        log.info("circuit breaker RESET — conditions normalized");
        await sendAlert("Circuit breaker RESET — protocol resuming normal operations.");

        // Unpause protocol on-chain
        try {
          const authority = loadKeypair();
          const unpauseIx = buildUpdateConfigIx({
            authority: authority.publicKey,
            isPaused: false,
            maxLeverage: 100_000, // restore 10x
            stressActive: false,  // V3: unblock correlated collateral
          });
          const tx = new Transaction().add(
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
            unpauseIx,
          );
          const sig = await connection.sendTransaction(tx, [authority]);
          await connection.confirmTransaction(sig, "confirmed");
          log.info({ sig }, "protocol UNPAUSED on-chain — circuit breaker reset");
        } catch (e) {
          log.error({ err: String(e) }, "FAILED to unpause protocol on-chain — manual intervention required");
        }
      }
      return;
    }

    if (checkTrigger(env.circuitBreakerThresholdBps)) {
      breakerState.triggered = true;
      breakerState.triggeredAt = now;
      breakerState.triggerPrice = price;

      log.fatal({
        price,
        dropPct: breakerState.dropPct,
        threshold: env.circuitBreakerThresholdBps / 100,
      }, "CIRCUIT BREAKER TRIGGERED");

      await sendAlert(
        `CIRCUIT BREAKER TRIGGERED: SOL dropped ${breakerState.dropPct.toFixed(1)}% in 4h ` +
        `(threshold: ${env.circuitBreakerThresholdBps / 100}%). ` +
        `Current price: $${price.toFixed(2)}. ` +
        `Protocol paused — leverage capped at 5x.`
      );

      // Pause protocol on-chain via update_config
      try {
        const authority = loadKeypair();
        const pauseIx = buildUpdateConfigIx({
          authority: authority.publicKey,
          isPaused: true,
          maxLeverage: 50_000, // 5x during circuit breaker
          stressActive: true,  // V3: block correlated collateral
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
        log.error({ err: String(e) }, "FAILED to pause protocol on-chain — manual intervention required");
      }
    }
  } catch (e) {
    log.error({ err: String(e) }, "circuit breaker tick failed");
  }
}

export async function startCircuitBreaker(): Promise<void> {
  log.info({ thresholdBps: env.circuitBreakerThresholdBps }, "circuit breaker starting");
  while (true) {
    await tick();
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) {
  startCircuitBreaker().catch(e => { log.error(String(e)); process.exit(1); });
}
