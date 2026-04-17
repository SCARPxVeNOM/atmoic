/**
 * Funding Rate Calculator — 8-hour TWAP Pyth-based.
 *
 * Per master-moves M-1: funding uses 8h Pyth TWAP, NEVER DFBA clearing price.
 * Outlier filtering: discard prices deviating >0.5% from rolling median.
 */

import { fetchLatestPrice } from "./pyth";

interface PriceSample {
  price6dp: bigint;
  timestamp: number;
}

const TWAP_WINDOW_MS = 8 * 60 * 60 * 1000; // 8 hours
const SAMPLE_INTERVAL_MS = 15 * 60 * 1000;  // 15 min
const OUTLIER_THRESHOLD_BPS = 50;            // 0.5%
const samples: PriceSample[] = [];

/** Collect a price sample from Pyth. Call every 15 minutes. */
export async function collectSample(): Promise<void> {
  try {
    const { price6dp } = await fetchLatestPrice();
    const now = Date.now();
    samples.push({ price6dp, timestamp: now });
    // Trim samples older than 8h
    const cutoff = now - TWAP_WINDOW_MS;
    while (samples.length > 0 && samples[0].timestamp < cutoff) samples.shift();
  } catch { /* skip failed sample */ }
}

/** Filter outliers: remove samples >0.5% from median. */
function filterOutliers(data: PriceSample[]): PriceSample[] {
  if (data.length < 3) return data;
  const sorted = [...data].sort((a, b) => Number(a.price6dp - b.price6dp));
  const median = sorted[Math.floor(sorted.length / 2)].price6dp;
  const threshold = (median * BigInt(OUTLIER_THRESHOLD_BPS)) / 10_000n;
  return data.filter(s => {
    const diff = s.price6dp > median ? s.price6dp - median : median - s.price6dp;
    return diff <= threshold;
  });
}

/** Compute 8h TWAP from stored samples. */
export function compute8hTwap(): { twapPrice: number; sampleCount: number } {
  const filtered = filterOutliers(samples);
  if (filtered.length === 0) return { twapPrice: 0, sampleCount: 0 };
  let sum = 0n;
  for (const s of filtered) sum += s.price6dp;
  const avg = sum / BigInt(filtered.length);
  return { twapPrice: Number(avg) / 1e6, sampleCount: filtered.length };
}

/** Compute funding rate: (mark - index) / index per 8h window. */
export function computeFundingRate(markPrice: number, indexPrice: number): {
  rate8h: number;
  rateAnnualized: number;
} {
  if (indexPrice === 0) return { rate8h: 0, rateAnnualized: 0 };
  const rate8h = ((markPrice - indexPrice) / indexPrice) * 100;
  const rateAnnualized = rate8h * (365 * 3); // 3 funding periods per day
  return { rate8h, rateAnnualized };
}

/** Return recent samples for the funding history API. */
export function getFundingHistory(): { timestamp: number; price: number; rate: number }[] {
  if (samples.length < 2) return [];
  const { twapPrice } = compute8hTwap();
  return samples.map(s => {
    const spot = Number(s.price6dp) / 1e6;
    const { rate8h } = computeFundingRate(spot, twapPrice || spot);
    return { timestamp: s.timestamp, price: spot, rate: rate8h };
  });
}

/** Start the sample collection loop. */
export function startFundingCollector(): void {
  collectSample(); // immediate first sample
  setInterval(collectSample, SAMPLE_INTERVAL_MS);
}
