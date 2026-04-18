/**
 * Points Service — aggregates trading volume and serves points API.
 *
 * Per composable-perps-docs section 15:
 * - GET /points/:wallet — user's points and stats
 * - GET /points/leaderboard — top traders
 */

import pino from "pino";
import { getPoints, getLeaderboard, recordTrade, resetEpoch } from "../lib/points-tracker";

const log = pino({ transport: { target: "pino-pretty" } } as any);

const EPOCH_MS = 7 * 24 * 60 * 60 * 1000;

/** Register points API routes on an Express app. */
export function registerPointsRoutes(app: any): void {
  app.get("/points/:wallet", (req: any, res: any) => {
    const data = getPoints(req.params.wallet);
    if (!data) return res.json({ wallet: req.params.wallet, points: 0, totalVolume: 0 });
    res.json(data);
  });

  app.get("/points/leaderboard", (_req: any, res: any) => {
    res.json(getLeaderboard(50));
  });
}

/** Start epoch reset timer. */
export function startEpochResetTimer(): void {
  setInterval(() => {
    log.info("resetting epoch volumes");
    resetEpoch();
  }, EPOCH_MS);
}
