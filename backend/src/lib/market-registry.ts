/**
 * Market Registry — extensible market listing system.
 *
 * Per composable-perps-docs Phase 4: support memecoin + long-tail markets.
 * Default markets: BTC, ETH, SOL. Extensible for BONK, WIF, etc.
 */

export interface Market {
  symbol: string;
  name: string;
  pythFeedId: string;
  maxLeverage: number;     // BPS (10000 = 10x)
  minNotional: number;     // USD minimum order size
  enabled: boolean;
  category: "major" | "alt" | "meme" | "rwa";
}

const DEFAULT_MARKETS: Market[] = [
  {
    symbol: "SOL-PERP",
    name: "Solana",
    pythFeedId: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    maxLeverage: 10_000,
    minNotional: 10,
    enabled: true,
    category: "major",
  },
  {
    symbol: "BTC-PERP",
    name: "Bitcoin",
    pythFeedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    maxLeverage: 20_000,
    minNotional: 10,
    enabled: false,
    category: "major",
  },
  {
    symbol: "ETH-PERP",
    name: "Ethereum",
    pythFeedId: "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    maxLeverage: 20_000,
    minNotional: 10,
    enabled: false,
    category: "major",
  },
  {
    symbol: "BONK-PERP",
    name: "Bonk",
    pythFeedId: "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419",
    maxLeverage: 5_000,
    minNotional: 50,
    enabled: false,
    category: "meme",
  },
];

const markets: Map<string, Market> = new Map(
  DEFAULT_MARKETS.map(m => [m.symbol, m])
);

export function getMarket(symbol: string): Market | undefined {
  return markets.get(symbol);
}

export function listMarkets(enabledOnly = false): Market[] {
  const all = [...markets.values()];
  return enabledOnly ? all.filter(m => m.enabled) : all;
}

export function addMarket(market: Market): void {
  markets.set(market.symbol, market);
}

export function enableMarket(symbol: string): boolean {
  const m = markets.get(symbol);
  if (!m) return false;
  m.enabled = true;
  return true;
}
