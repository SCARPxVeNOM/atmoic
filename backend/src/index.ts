import pino from "pino";
import { startLiquidator } from "./services/liquidator";
import { startApi } from "./services/api";
import { startCircuitBreaker } from "./services/circuit-breaker";
import { startDepMonitor } from "./services/dep-monitor";
import { startFundingCollector } from "./lib/funding";
import { startMsolMonitor } from "./services/msol-monitor";

const log = pino({ transport: { target: "pino-pretty" } } as any);

async function main() {
  startApi();
  startFundingCollector(); // 15-min Pyth TWAP samples for funding rate (M-1)
  // Oracle relay is OFF by default on mainnet — Pyth publishers keep feeds
  // fresh without our help. Turn it on with `npm run oracle-relay` if we
  // start seeing OracleStale rejections.
  await Promise.all([
    startLiquidator(),
    startCircuitBreaker(),
    startDepMonitor(),
    startMsolMonitor(),
  ]);
}

main().catch((e) => {
  log.error({ err: String(e) }, "fatal");
  process.exit(1);
});
