import { env } from "./env";
import { fetchSwitchboardPrice } from "./switchboard";

export interface HermesPrice {
  price6dp: bigint;
  confidence6dp: bigint;
  publishTime: number;
  feedId: string;
}

// Mainnet SOL/USD Pyth feed ID (hex, no 0x prefix).
export const SOL_USD_FEED_ID =
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

/**
 * Fetches the latest SOL/USD price from the free public Hermes endpoint.
 * No auth required. Safe to call at runtime.
 */
export async function fetchLatestPrice(feedId: string = SOL_USD_FEED_ID): Promise<HermesPrice> {
  try {
    return await fetchFromHermes(feedId);
  } catch (hermesErr) {
    // Fallback to Switchboard on-chain data
    try {
      const sw = await fetchSwitchboardPrice();
      const now = Math.floor(Date.now() / 1000);
      // Reject if Switchboard data is older than 30s
      if (now - sw.publishTime > 30) throw new Error("Switchboard data stale");
      return {
        price6dp: sw.price6dp,
        confidence6dp: 0n,
        publishTime: sw.publishTime,
        feedId,
      };
    } catch {
      // Both failed — throw original Hermes error
      throw hermesErr;
    }
  }
}

export async function fetchFromHermes(feedId: string = SOL_USD_FEED_ID): Promise<HermesPrice> {
  const url = `${env.hermesUrl}/v2/updates/price/latest?ids[]=${feedId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Hermes ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as {
    parsed: Array<{
      id: string;
      price: { price: string; conf: string; expo: number; publish_time: number };
    }>;
  };
  const p = json.parsed[0];
  if (!p) throw new Error(`No price parsed for feed ${feedId}`);

  const rawPrice = BigInt(p.price.price);
  const rawConf = BigInt(p.price.conf);
  const expo = p.price.expo;
  const shift = expo - -6;

  const normalize = (v: bigint): bigint => {
    if (shift >= 0) return v * 10n ** BigInt(shift);
    return v / 10n ** BigInt(-shift);
  };

  return {
    price6dp: normalize(rawPrice),
    confidence6dp: normalize(rawConf),
    publishTime: p.price.publish_time,
    feedId: p.id,
  };
}

/**
 * Fetches the full Hermes update payload (VAA) so it can be posted
 * on-chain via the Pyth receiver program.
 */
export async function fetchPriceUpdateVaa(feedId: string = SOL_USD_FEED_ID): Promise<string[]> {
  const url = `${env.hermesUrl}/v2/updates/price/latest?ids[]=${feedId}&encoding=base64`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Hermes ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { binary: { data: string[] } };
  return json.binary.data;
}
