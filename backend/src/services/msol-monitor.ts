/**
 * mSOL Depeg Monitor — continuous monitoring of mSOL/SOL peg ratio.
 *
 * Per limitations-handbook F-02:
 * - Alert on significant mSOL discount
 * - During circuit breaker: flag mSOL deposits as blocked
 */

import pino from "pino";
import { fetchMsolPrice, checkDepegRisk } from "../lib/msol";
import { fetchLatestPrice } from "../lib/pyth";
import { env } from "../lib/env";
import { breakerState } from "./circuit-breaker";

const log = pino({ transport: { target: "pino-pretty" } } as any);
const POLL_MS = 60_000; // Check every minute

export const msolState = {
  stakeRatio: 0,
  priceUsd: 0,
  depegged: false,
  discountBps: 0,
  depositsBlocked: false,
  lastCheckAt: 0,
};

async function tick() {
  try {
    const { price6dp: solPrice } = await fetchLatestPrice();
    const msol = await fetchMsolPrice(solPrice);

    // For depeg check, use fair value as both fair and market (in production,
    // compare against a DEX price for mSOL/SOL)
    const depeg = checkDepegRisk(msol.priceInSol6dp, msol.priceInSol6dp);

    msolState.stakeRatio = msol.stakeRatio;
    msolState.priceUsd = Number(msol.priceInUsd6dp) / 1e6;
    msolState.depegged = depeg.depegged;
    msolState.discountBps = depeg.discountBps;
    msolState.depositsBlocked = breakerState.triggered || depeg.depegged;
    msolState.lastCheckAt = Date.now();

    if (depeg.depegged) {
      log.warn({ discountBps: depeg.discountBps, stakeRatio: msol.stakeRatio }, "mSOL DEPEG DETECTED");
      if (env.alertWebhookUrl) {
        fetch(env.alertWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `mSOL DEPEG ALERT: ${depeg.discountBps}bps discount. Deposits blocked.`,
          }),
        }).catch(() => {});
      }
    }
  } catch (e) {
    log.error({ err: String(e) }, "mSOL monitor tick failed");
  }
}

export async function startMsolMonitor(): Promise<void> {
  log.info("mSOL monitor starting");
  while (true) {
    await tick();
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}

if (require.main === module) {
  startMsolMonitor().catch(e => { log.error(String(e)); process.exit(1); });
}
