/**
 * Dev-time only. Uses the Pyth Pro Crypto API key to pull historical SOL/USD
 * candles and compute a rolling volatility estimate. Output is written to
 * `backend/src/generated/volatility.json` and committed to the repo as a
 * static calibration input for the on-chain dynamic-spread (M-2) logic.
 *
 * Runtime code must NEVER read the Pyth Pro key. Trial expires ~2026-04-17
 * and the Pro license forbids redistribution (see project_pyth_api_key memory).
 */
import * as fs from "fs";
import * as path from "path";
import { env } from "../src/lib/env";

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

async function fetchCandles(symbol: string, resolution: string, lookbackSec: number): Promise<Candle[]> {
  if (!env.pythProApiKey) throw new Error("PYTH_PRO_API_KEY not set — see backend/.env.example");
  const now = Math.floor(Date.now() / 1000);
  const url = `https://benchmarks.pyth.network/v1/shims/tradingview/history?symbol=${symbol}&resolution=${resolution}&from=${now - lookbackSec}&to=${now}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${env.pythProApiKey}` },
  });
  if (!res.ok) throw new Error(`Pyth ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { t: number[]; o: number[]; h: number[]; l: number[]; c: number[] };
  return json.t.map((t, i) => ({
    time: t,
    open: json.o[i],
    high: json.h[i],
    low: json.l[i],
    close: json.c[i],
  }));
}

function realizedVolBps(candles: Candle[]): number {
  if (candles.length < 2) return 0;
  const rets: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    rets.push(Math.log(candles[i].close / candles[i - 1].close));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  const stdev = Math.sqrt(variance);
  // Annualize assuming 1-min bars → 525,600 bars per year.
  const annualized = stdev * Math.sqrt(525_600);
  return Math.round(annualized * 10_000);
}

async function main() {
  const candles = await fetchCandles("Crypto.SOL/USD", "1", 24 * 3600);
  const volBps = realizedVolBps(candles);
  const output = {
    generatedAt: new Date().toISOString(),
    symbol: "Crypto.SOL/USD",
    sampleBars: candles.length,
    annualizedVolBps: volBps,
    sourceNote:
      "Derived from Pyth Pro historical candles at dev time. Do NOT redistribute raw source data.",
  };
  const outPath = path.resolve(__dirname, "../src/generated/volatility.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`Wrote ${outPath}: ${volBps} bps annualized`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
