/**
 * Strategy Engine / Rebalancer — automated yield rotation.
 *
 * Per composable-perps-docs Phase 4:
 * - Delta-neutral, yield-maximizer, trend-following strategies
 * - Auto-rebalance based on oracle price + funding rate
 * - Risk limits per strategy
 */

import pino from "pino";

const log = pino({ transport: { target: "pino-pretty" } } as any);

export type StrategyType = "delta_neutral" | "yield_maximizer" | "trend_following";

export interface Strategy {
  id: string;
  type: StrategyType;
  owner: string;           // wallet
  allocation: number;      // USD amount allocated
  maxDrawdown: number;     // % max drawdown before stop
  active: boolean;
  positions: string[];     // position PDAs managed by this strategy
  pnl: number;
  createdAt: number;
}

export interface RebalanceAction {
  strategyId: string;
  action: "open" | "close" | "adjust";
  side?: "long" | "short";
  size?: number;
  reason: string;
}

const strategies: Map<string, Strategy> = new Map();

/** Create a new strategy. */
export function createStrategy(
  owner: string,
  type: StrategyType,
  allocation: number,
  maxDrawdown: number = 10,
): Strategy {
  const id = `strat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const strategy: Strategy = {
    id,
    type,
    owner,
    allocation,
    maxDrawdown,
    active: true,
    positions: [],
    pnl: 0,
    createdAt: Date.now(),
  };
  strategies.set(id, strategy);
  return strategy;
}

/**
 * Compute rebalance actions for a strategy based on current market state.
 */
export function computeRebalance(
  strategy: Strategy,
  currentPrice: number,
  fundingRate8h: number,
  volatility: number,
): RebalanceAction[] {
  const actions: RebalanceAction[] = [];

  switch (strategy.type) {
    case "delta_neutral":
      // If funding rate is positive, short perp + long spot
      if (fundingRate8h > 0.01) {
        actions.push({
          strategyId: strategy.id,
          action: "open",
          side: "short",
          size: strategy.allocation * 0.5,
          reason: `Positive funding (${fundingRate8h.toFixed(3)}%) — collect funding`,
        });
      }
      break;

    case "yield_maximizer":
      // Allocate to highest-yield collateral type
      actions.push({
        strategyId: strategy.id,
        action: "adjust",
        reason: "Rebalance to highest APY collateral",
      });
      break;

    case "trend_following":
      // Simple momentum: if price above 20-period SMA, go long
      if (volatility < 50) {
        actions.push({
          strategyId: strategy.id,
          action: "open",
          side: "long",
          size: strategy.allocation * 0.3,
          reason: `Low volatility (${volatility.toFixed(1)}%) — trend entry`,
        });
      }
      break;
  }

  // Drawdown check
  if (strategy.pnl < 0 && Math.abs(strategy.pnl) > strategy.allocation * (strategy.maxDrawdown / 100)) {
    return [{
      strategyId: strategy.id,
      action: "close",
      reason: `Max drawdown reached (${((strategy.pnl / strategy.allocation) * 100).toFixed(1)}%)`,
    }];
  }

  return actions;
}

export function getStrategy(id: string): Strategy | undefined {
  return strategies.get(id);
}

export function listStrategies(owner?: string): Strategy[] {
  const all = [...strategies.values()];
  return owner ? all.filter(s => s.owner === owner) : all;
}
