/**
 * xStocks / RWA Integration — equity perps (AAPL, TSLA, SPY).
 *
 * Per composable-perps-docs Phase 4:
 * - Different oracle validation (equity feeds vs crypto)
 * - Trading hours enforcement (NYSE: 9:30-16:00 ET)
 * - Different funding rate mechanics
 */

export interface RwaMarket {
  symbol: string;
  name: string;
  pythFeedId: string;
  tradingHours: { open: string; close: string; timezone: string };
  maxLeverage: number;
}

const RWA_MARKETS: RwaMarket[] = [
  {
    symbol: "AAPL-PERP",
    name: "Apple Inc.",
    pythFeedId: "49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688",
    tradingHours: { open: "09:30", close: "16:00", timezone: "America/New_York" },
    maxLeverage: 5_000, // 5x for equities
  },
  {
    symbol: "TSLA-PERP",
    name: "Tesla Inc.",
    pythFeedId: "16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1",
    tradingHours: { open: "09:30", close: "16:00", timezone: "America/New_York" },
    maxLeverage: 5_000,
  },
  {
    symbol: "SPY-PERP",
    name: "S&P 500 ETF",
    pythFeedId: "19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5",
    tradingHours: { open: "09:30", close: "16:00", timezone: "America/New_York" },
    maxLeverage: 10_000,
  },
];

/**
 * Check if a market is currently within trading hours.
 */
export function isMarketOpen(market: RwaMarket): boolean {
  const now = new Date();
  // Simple UTC-based check (production: use timezone-aware library)
  const etOffset = -4; // EDT
  const etHour = (now.getUTCHours() + etOffset + 24) % 24;
  const etMin = now.getUTCMinutes();
  const currentTime = etHour * 60 + etMin;

  const [openH, openM] = market.tradingHours.open.split(":").map(Number);
  const [closeH, closeM] = market.tradingHours.close.split(":").map(Number);
  const openTime = openH * 60 + openM;
  const closeTime = closeH * 60 + closeM;

  // Weekend check
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false;

  return currentTime >= openTime && currentTime <= closeTime;
}

export function getRwaMarkets(): RwaMarket[] {
  return RWA_MARKETS;
}

export function getRwaMarket(symbol: string): RwaMarket | undefined {
  return RWA_MARKETS.find(m => m.symbol === symbol);
}
