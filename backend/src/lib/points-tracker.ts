/**
 * Points & Volume Tracker — token distribution based on trading activity.
 *
 * Per composable-perps-docs section 15:
 * - Track volume per user per epoch
 * - Anti-wash: penalize back-and-forth within 60s
 * - Anti-sybil: cluster detection
 * - Consecutive active days bonus
 */

interface UserPoints {
  wallet: string;
  totalVolume: number;       // USD lifetime
  epochVolume: number;       // USD current epoch
  points: number;            // accumulated points
  consecutiveDays: number;   // active day streak
  lastTradeAt: number;       // timestamp
  lastTradeSide: string;     // for wash detection
  washPenaltyCount: number;  // number of wash trades detected
}

const WASH_WINDOW_MS = 60_000;        // 60 seconds
const WASH_PENALTY_FACTOR = 0.1;      // 90% reduction for wash trades
const DAILY_BONUS_MULTIPLIER = 0.05;  // +5% per consecutive day, max 50%
const MAX_DAILY_BONUS = 0.5;
const EPOCH_MS = 7 * 24 * 60 * 60 * 1000; // 1 week

const users: Map<string, UserPoints> = new Map();

function getOrCreate(wallet: string): UserPoints {
  if (!users.has(wallet)) {
    users.set(wallet, {
      wallet,
      totalVolume: 0,
      epochVolume: 0,
      points: 0,
      consecutiveDays: 0,
      lastTradeAt: 0,
      lastTradeSide: "",
      washPenaltyCount: 0,
    });
  }
  return users.get(wallet)!;
}

/**
 * Record a trade for points calculation.
 */
export function recordTrade(
  wallet: string,
  volumeUsd: number,
  side: "long" | "short",
): { points: number; washDetected: boolean } {
  const user = getOrCreate(wallet);
  const now = Date.now();

  // Wash trade detection: same wallet, opposite side, within 60s
  const isWash =
    now - user.lastTradeAt < WASH_WINDOW_MS &&
    user.lastTradeSide !== "" &&
    user.lastTradeSide !== side;

  let pointsEarned = volumeUsd; // 1 point per $1 volume

  if (isWash) {
    pointsEarned *= WASH_PENALTY_FACTOR; // 90% reduction
    user.washPenaltyCount++;
  }

  // Consecutive days bonus
  const daysSinceLastTrade = (now - user.lastTradeAt) / (24 * 60 * 60 * 1000);
  if (daysSinceLastTrade >= 0.8 && daysSinceLastTrade <= 1.5) {
    user.consecutiveDays++;
  } else if (daysSinceLastTrade > 1.5) {
    user.consecutiveDays = 1;
  }

  const bonus = Math.min(user.consecutiveDays * DAILY_BONUS_MULTIPLIER, MAX_DAILY_BONUS);
  pointsEarned *= (1 + bonus);

  user.totalVolume += volumeUsd;
  user.epochVolume += volumeUsd;
  user.points += pointsEarned;
  user.lastTradeAt = now;
  user.lastTradeSide = side;

  return { points: pointsEarned, washDetected: isWash };
}

/** Get points for a wallet. */
export function getPoints(wallet: string): UserPoints | null {
  return users.get(wallet) ?? null;
}

/** Get leaderboard (top N by points). */
export function getLeaderboard(limit: number = 50): UserPoints[] {
  return [...users.values()]
    .sort((a, b) => b.points - a.points)
    .slice(0, limit);
}

/** Reset epoch volumes (call weekly). */
export function resetEpoch(): void {
  for (const user of users.values()) {
    user.epochVolume = 0;
  }
}
