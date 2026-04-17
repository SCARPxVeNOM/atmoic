/**
 * Dependency Monitor — watches external protocol programs for on-chain upgrades.
 *
 * Monitors Kamino Klend and Pyth Receiver program accounts. If the
 * `lastDeploySlot` changes from the baseline recorded at startup,
 * logs a CRITICAL alert and optionally posts to a webhook.
 */

import { PublicKey } from "@solana/web3.js";
import pino from "pino";
import { connection } from "../lib/connection";
import { env } from "../lib/env";

const log = pino({ transport: { target: "pino-pretty" } } as any);

const PROGRAMS_TO_WATCH = [
  { name: "Kamino Klend", id: new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD") },
  { name: "Pyth Receiver", id: new PublicKey("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ") },
];

// Baseline deploy slots recorded at first boot.
const baselines: Map<string, bigint> = new Map();

async function getLastDeploySlot(programId: PublicKey): Promise<bigint | null> {
  const acct = await connection.getAccountInfo(programId);
  if (!acct || acct.data.length < 44) return null;
  // BPF Upgradeable Loader program account: first 4 bytes = account type,
  // next 32 bytes = programdata address. We read the programdata account
  // to get lastDeploySlot at offset 8 (u64 LE after the 4-byte state + 4 padding).
  const programDataAddr = new PublicKey(acct.data.subarray(4, 36));
  const pdAcct = await connection.getAccountInfo(programDataAddr);
  if (!pdAcct || pdAcct.data.length < 16) return null;
  return pdAcct.data.readBigUInt64LE(8);
}

async function sendAlert(message: string) {
  log.fatal(message);
  const webhook = env.alertWebhookUrl;
  if (!webhook) return;
  try {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  } catch (e) {
    log.error({ err: String(e) }, "failed to send alert webhook");
  }
}

async function checkOnce() {
  for (const prog of PROGRAMS_TO_WATCH) {
    try {
      const slot = await getLastDeploySlot(prog.id);
      if (slot === null) continue;

      const key = prog.id.toBase58();
      const baseline = baselines.get(key);

      if (baseline === undefined) {
        baselines.set(key, slot);
        log.info({ program: prog.name, slot: slot.toString() }, "baseline recorded");
      } else if (slot !== baseline) {
        await sendAlert(
          `CRITICAL: ${prog.name} (${key}) was upgraded! ` +
          `Baseline slot: ${baseline}, new slot: ${slot}. ` +
          `Review changes before allowing new positions.`
        );
        baselines.set(key, slot); // Update baseline so we don't re-alert
      }
    } catch (e) {
      log.warn({ program: prog.name, err: String(e) }, "check failed");
    }
  }
}

export async function startDepMonitor(): Promise<void> {
  const pollMs = env.depMonitorPollMs;
  log.info({ pollMs, programs: PROGRAMS_TO_WATCH.map(p => p.name) }, "dependency monitor starting");

  while (true) {
    await checkOnce();
    await new Promise(r => setTimeout(r, pollMs));
  }
}

if (require.main === module) {
  startDepMonitor().catch(e => { log.error(String(e)); process.exit(1); });
}
