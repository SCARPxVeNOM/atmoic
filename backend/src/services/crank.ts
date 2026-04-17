/**
 * Crank Service — 3-provider redundant batch executor.
 *
 * Per limitations-handbook A-03 and composable-perps-docs:
 * - 3 independent RPC providers attempt execute_batch simultaneously
 * - First success wins, others fail with "account already modified"
 * - Liveness alert if no batch in 5 seconds
 * - Jito bundle submission with configurable tip
 * - Permissionless: any third party can run a crank and earn fees
 */

import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import pino from "pino";
import { env } from "../lib/env";
import { loadKeypair } from "../lib/connection";
import { buildExecuteBatchIx, findQueueShardPda } from "../lib/ix-builders";

const log = pino({ transport: { target: "pino-pretty" } } as any);

interface CrankProvider {
  name: string;
  connection: Connection;
}

export const crankStats = {
  batchesExecuted: 0,
  lastBatchAt: 0,
  lastError: null as string | null,
  providerStatus: {} as Record<string, { successes: number; failures: number }>,
};

function getProviders(): CrankProvider[] {
  const providers: CrankProvider[] = [];
  const urls = [env.crankRpc1, env.crankRpc2, env.crankRpc3].filter(Boolean);

  // Fallback to primary RPC if no crank-specific RPCs configured
  if (urls.length === 0) urls.push(env.rpcUrl);

  urls.forEach((url, i) => {
    const name = `provider-${i}`;
    providers.push({ name, connection: new Connection(url!, "confirmed") });
    crankStats.providerStatus[name] = { successes: 0, failures: 0 };
  });

  return providers;
}

/**
 * Submit batch execution through a single provider.
 * Returns the tx signature on success, null on failure.
 */
async function submitBatch(
  provider: CrankProvider,
  cranker: Keypair,
  batchIx: any, // The execute_batch instruction (built by ix-builders when on-chain is ready)
): Promise<string | null> {
  try {
    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: env.jitoTipLamports }),
      batchIx,
    );

    const sig = await provider.connection.sendTransaction(tx, [cranker], {
      skipPreflight: false,
    });
    await provider.connection.confirmTransaction(sig, "confirmed");

    crankStats.providerStatus[provider.name].successes++;
    return sig;
  } catch (e: any) {
    crankStats.providerStatus[provider.name].failures++;
    // "account already modified" is expected when another provider won the race
    if (String(e).includes("already been processed") || String(e).includes("modified")) {
      return null; // Not a real failure — another provider already executed
    }
    log.warn({ provider: provider.name, err: String(e) }, "crank submit failed");
    return null;
  }
}

/**
 * Execute one batch round: all providers race to submit.
 */
async function executeBatchRound(
  providers: CrankProvider[],
  cranker: Keypair,
  buildBatchIx: () => any,
): Promise<boolean> {
  const batchIx = buildBatchIx();
  if (!batchIx) return false; // No orders to process

  const results = await Promise.allSettled(
    providers.map(p => submitBatch(p, cranker, batchIx))
  );

  const success = results.some(
    r => r.status === "fulfilled" && r.value !== null
  );

  if (success) {
    crankStats.batchesExecuted++;
    crankStats.lastBatchAt = Date.now();
    log.info({ batch: crankStats.batchesExecuted }, "batch executed");
  }

  return success;
}

/**
 * Liveness monitor — alerts if no batch executed within threshold.
 */
function startLivenessMonitor(thresholdMs: number = 5000) {
  setInterval(() => {
    if (crankStats.lastBatchAt === 0) return; // Never started
    const elapsed = Date.now() - crankStats.lastBatchAt;
    if (elapsed > thresholdMs) {
      log.fatal({ elapsed, threshold: thresholdMs }, "CRANK LIVENESS ALERT — no batch executed");
      // In production: fire PagerDuty alert
      if (env.alertWebhookUrl) {
        fetch(env.alertWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `CRANK LIVENESS ALERT: No batch executed in ${elapsed}ms (threshold: ${thresholdMs}ms)`,
          }),
        }).catch(() => {});
      }
    }
  }, thresholdMs);
}

/**
 * Start the crank service.
 *
 * @param buildBatchIx Function that builds the execute_batch instruction.
 *   Returns null if no orders are queued. This will be wired to the
 *   on-chain instruction builder once the program upgrade is deployed.
 * @param intervalMs  Batch interval (default 100ms per DFBA spec)
 */
export async function startCrankService(
  buildBatchIx: () => any,
  intervalMs: number = 100,
): Promise<void> {
  const providers = getProviders();
  const cranker = loadKeypair();

  log.info({
    providers: providers.length,
    intervalMs,
    cranker: cranker.publicKey.toBase58(),
  }, "crank service starting");

  startLivenessMonitor();

  while (true) {
    try {
      await executeBatchRound(providers, cranker, buildBatchIx);
    } catch (e) {
      crankStats.lastError = String(e);
      log.error({ err: String(e) }, "crank round failed");
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

if (require.main === module) {
  const PYTH_SOL_FEED = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
  // Collect all 16 queue shards (market=0 SOL, sides 0+1, shards 0-7)
  const shardPdas: PublicKey[] = [];
  for (let side = 0; side <= 1; side++) {
    for (let shard = 0; shard < 8; shard++) {
      const [pda] = findQueueShardPda(0, side, shard);
      shardPdas.push(pda);
    }
  }

  startCrankService(() => {
    const cranker = loadKeypair(env.liquidatorKeypairPath);
    return buildExecuteBatchIx({
      cranker: cranker.publicKey,
      pythPriceFeed: PYTH_SOL_FEED,
      queueShards: shardPdas,
    });
  }).catch(e => { log.error(String(e)); process.exit(1); });
}
