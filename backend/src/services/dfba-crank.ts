/**
 * DFBA Batch Clearing Crank
 *
 * Runs every 15 seconds, iterating over all markets (SOL-PERP, BTC-PERP, ETH-PERP).
 * For each market: fetches current Pyth oracle price, runs batch clearing,
 * logs results. Fills are stored in-memory for the /batch/fills endpoint.
 */

import pino from "pino";
import { runBatchClearing } from "../lib/dfba";
import { fetchLatestPrice } from "../lib/pyth";

const log = pino({ transport: { target: "pino-pretty" } } as any);

const BATCH_INTERVAL_MS = 15_000; // 15 seconds

const MARKET_FEEDS: Record<string, string> = {
  "SOL-PERP": "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "BTC-PERP": "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "ETH-PERP": "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
};

let batchCount = 0;
let totalFills = 0;

async function runCycle() {
  batchCount++;

  for (const [market, feedId] of Object.entries(MARKET_FEEDS)) {
    try {
      const { price6dp } = await fetchLatestPrice(feedId);
      const fills = runBatchClearing(market, price6dp);

      if (fills > 0) {
        totalFills += fills;
        log.info({
          market,
          fills,
          oraclePrice: (Number(price6dp) / 1e6).toFixed(2),
          batchNumber: batchCount,
          totalFills,
        }, "DFBA batch cleared — orders matched");
      }
    } catch (e) {
      log.warn({ market, err: String(e) }, "DFBA crank: failed to clear market");
    }
  }
}

export function startDfbaCrank(): void {
  log.info({ intervalMs: BATCH_INTERVAL_MS, markets: Object.keys(MARKET_FEEDS) }, "DFBA batch clearing crank started");

  // Run first cycle after a short delay (let oracle warm up)
  setTimeout(() => {
    runCycle();
    setInterval(runCycle, BATCH_INTERVAL_MS);
  }, 3000);
}
