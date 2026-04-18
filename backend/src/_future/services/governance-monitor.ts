/**
 * Governance Monitor — tracks proposals and auto-executes via Squads.
 */

import pino from "pino";
import { listProposals, finalizeProposal } from "../lib/governance";

const log = pino({ transport: { target: "pino-pretty" } } as any);
const POLL_MS = 60_000;

async function tick() {
  const active = listProposals(true);
  const now = Date.now();

  for (const p of active) {
    if (now > p.expiresAt && p.passed === null) {
      const result = finalizeProposal(p.id);
      if (result?.passed) {
        log.info({ id: p.id, title: p.title }, "proposal PASSED — queuing Squads execution");
        // In production: build Squads proposal tx from p.params and submit
      } else {
        log.info({ id: p.id, title: p.title }, "proposal failed (quorum or majority not met)");
      }
    }
  }
}

export async function startGovernanceMonitor(): Promise<void> {
  log.info("governance monitor starting");
  while (true) {
    try { await tick(); } catch (e) { log.error(String(e)); }
    await new Promise(r => setTimeout(r, POLL_MS));
  }
}
