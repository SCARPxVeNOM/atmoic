import { PositionData, Side } from "./decode";

// Correlation matrix between markets (hardcoded for SOL/BTC/ETH)
const FEED_CORRELATIONS: Record<string, Record<string, number>> = {
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE": { // SOL
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE": 1.0,
    "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo": 0.75,
    "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC": 0.70,
  },
  "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo": { // BTC
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE": 0.75,
    "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo": 1.0,
    "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC": 0.85,
  },
  "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC": { // ETH
    "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE": 0.70,
    "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo": 0.85,
    "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC": 1.0,
  },
};

const FEED_TO_LABEL: Record<string, string> = {
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE": "SOL",
  "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo": "BTC",
  "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC": "ETH",
};

// 15 stress scenarios: combinations of price moves
interface Scenario {
  label: string;
  moves: Record<string, number>; // feed → price change multiplier (e.g., 0.85 = -15%)
}

function generateScenarios(): Scenario[] {
  const feeds = Object.keys(FEED_TO_LABEL);
  const shocks = [0.85, 0.90, 0.95, 1.0, 1.05, 1.10, 1.15];
  const scenarios: Scenario[] = [];

  // Generate representative correlated scenarios
  const combos: [number, number, number][] = [
    // Everything crashes
    [0.85, 0.90, 0.90],
    [0.90, 0.85, 0.88],
    [0.90, 0.90, 0.85],
    // Everything pumps
    [1.15, 1.10, 1.10],
    [1.10, 1.15, 1.12],
    [1.10, 1.10, 1.15],
    // Divergence (hedge benefits)
    [0.85, 1.05, 1.00],
    [1.15, 0.95, 1.00],
    [0.85, 1.00, 1.05],
    [1.15, 1.00, 0.95],
    [1.00, 0.85, 1.05],
    [1.00, 1.15, 0.95],
    // Moderate moves
    [0.95, 0.95, 0.95],
    [1.05, 1.05, 1.05],
    // Flat
    [1.00, 1.00, 1.00],
  ];

  for (const [s, b, e] of combos) {
    const moves: Record<string, number> = {};
    moves[feeds[0]] = s; // SOL
    moves[feeds[1]] = b; // BTC
    moves[feeds[2]] = e; // ETH
    const parts = [
      `SOL ${((s - 1) * 100).toFixed(0)}%`,
      `BTC ${((b - 1) * 100).toFixed(0)}%`,
      `ETH ${((e - 1) * 100).toFixed(0)}%`,
    ];
    scenarios.push({ label: parts.join(", "), moves });
  }

  return scenarios;
}

const SCENARIOS = generateScenarios();

export interface PositionMarginDetail {
  market: string;
  side: string;
  notionalUsd: number;
  individualMarginUsd: number;
  portfolioContribution: number;
}

export interface PortfolioMarginResult {
  portfolioMarginUsd: number;
  individualMarginUsd: number;
  savingsUsd: number;
  savingsPct: number;
  worstScenario: string;
  portfolioHealthBps: number;
  totalCollateralUsd: number;
  positions: PositionMarginDetail[];
  correlationMatrix: { markets: string[]; values: number[][] };
}

function computePositionPnl(
  pos: PositionData,
  currentPrice: number,
  stressedPrice: number,
): number {
  const entry = Number(pos.entryPrice) / 1e6;
  const size = Number(pos.perpSize) / 1e6;
  if (entry === 0 || size === 0) return 0;

  const power = Number(pos.powerMilli ?? 0n);
  const p = (power === 0 || power === 1000) ? 1 : power / 1000;

  let priceDelta: number;
  if (p === 2) {
    const exitSq = stressedPrice * stressedPrice;
    const entrySq = entry * entry;
    priceDelta = (exitSq - entrySq) / entrySq;
  } else {
    priceDelta = (stressedPrice - entry) / entry;
  }

  const sideMul = pos.perpSide === Side.Long ? 1 : -1;
  return priceDelta * size * sideMul;
}

export function computePortfolioMargin(
  positions: PositionData[],
  prices: Record<string, number>,
): PortfolioMarginResult {
  const openPositions = positions.filter((p) => p.isOpen);

  if (openPositions.length === 0) {
    const markets = Object.values(FEED_TO_LABEL);
    return {
      portfolioMarginUsd: 0,
      individualMarginUsd: 0,
      savingsUsd: 0,
      savingsPct: 0,
      worstScenario: "N/A",
      portfolioHealthBps: 99999,
      totalCollateralUsd: 0,
      positions: [],
      correlationMatrix: { markets, values: markets.map(() => markets.map(() => 0)) },
    };
  }

  // Individual margin: sum of 5% of each position's notional
  let individualMarginUsd = 0;
  const posDetails: PositionMarginDetail[] = [];

  for (const pos of openPositions) {
    const feedKey = pos.perpMarket.toBase58();
    const notional = Number(pos.perpSize) / 1e6;
    const indMargin = notional * 0.05; // 5% maintenance margin
    individualMarginUsd += indMargin;
    posDetails.push({
      market: FEED_TO_LABEL[feedKey] ?? feedKey.slice(0, 8),
      side: pos.perpSide === Side.Long ? "Long" : "Short",
      notionalUsd: notional,
      individualMarginUsd: indMargin,
      portfolioContribution: 0,
    });
  }

  // Portfolio margin: max loss across stress scenarios
  let worstLoss = 0;
  let worstLabel = "No stress";

  for (const scenario of SCENARIOS) {
    let portfolioPnl = 0;
    for (const pos of openPositions) {
      const feedKey = pos.perpMarket.toBase58();
      const currentPrice = prices[feedKey] ?? Number(pos.entryPrice) / 1e6;
      const move = scenario.moves[feedKey] ?? 1.0;
      const stressedPrice = currentPrice * move;
      portfolioPnl += computePositionPnl(pos, currentPrice, stressedPrice);
    }
    const loss = Math.abs(Math.min(0, portfolioPnl));
    if (loss > worstLoss) {
      worstLoss = loss;
      worstLabel = scenario.label;
    }
  }

  const portfolioMarginUsd = Math.max(worstLoss, 0);
  const savingsUsd = Math.max(0, individualMarginUsd - portfolioMarginUsd);
  const savingsPct = individualMarginUsd > 0 ? (savingsUsd / individualMarginUsd) * 100 : 0;

  // Total collateral across all positions
  let totalCollateralUsd = 0;
  for (const pos of openPositions) {
    const feedKey = pos.perpMarket.toBase58();
    const price = prices[feedKey] ?? Number(pos.entryPrice) / 1e6;
    totalCollateralUsd += (Number(pos.collateralAmount) / 1e9) * price;
  }

  const portfolioHealthBps = portfolioMarginUsd > 0
    ? Math.round((totalCollateralUsd / portfolioMarginUsd) * 10000)
    : 99999;

  // Build correlation matrix for active markets
  const activeFeeds = [...new Set(openPositions.map((p) => p.perpMarket.toBase58()))];
  const markets = activeFeeds.map((f) => FEED_TO_LABEL[f] ?? f.slice(0, 8));
  const values = activeFeeds.map((f1) =>
    activeFeeds.map((f2) => FEED_CORRELATIONS[f1]?.[f2] ?? 0),
  );

  return {
    portfolioMarginUsd,
    individualMarginUsd,
    savingsUsd,
    savingsPct,
    worstScenario: worstLabel,
    portfolioHealthBps,
    totalCollateralUsd,
    positions: posDetails,
    correlationMatrix: { markets, values },
  };
}
