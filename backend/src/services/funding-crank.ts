import {
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import pino from "pino";

import { connection, loadKeypair, programId } from "../lib/connection";
import { findConfigPda } from "../lib/pdas";
import { decodeGlobalConfig, decodePosition } from "../lib/decode";
import { fetchLatestPrice } from "../lib/pyth";
import { compute8hTwap, computeFundingRate } from "../lib/funding";
import { buildSettleFundingIx } from "../lib/ix-builders";

const log = pino({ transport: { target: "pino-pretty" } } as any);

const FUNDING_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours

export const fundingCrankStats = {
  lastRunAt: 0,
  positionsSettled: 0,
  lastRateBps: 0,
  errors: 0,
};

async function fetchOpenPositions(): Promise<{ owner: PublicKey; pubkey: PublicKey }[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      // Position accounts: INIT_SPACE = 187 bytes + 8 byte discriminator = 195
      { dataSize: 195 },
    ],
  });

  const positions: { owner: PublicKey; pubkey: PublicKey }[] = [];
  for (const { pubkey, account } of accounts) {
    try {
      const pos = decodePosition(account.data);
      if (pos.isOpen) {
        positions.push({ owner: pos.owner, pubkey });
      }
    } catch {
      // Not a position account or corrupted — skip
    }
  }
  return positions;
}

async function runFundingRound(): Promise<void> {
  try {
    // 1. Check if enough TWAP samples exist
    const { twapPrice, sampleCount } = compute8hTwap();
    if (sampleCount < 3) {
      log.info({ sampleCount }, "funding crank: not enough TWAP samples, skipping");
      return;
    }

    // 2. Compute funding rate
    const { price6dp } = await fetchLatestPrice();
    const spotPrice = Number(price6dp) / 1e6;
    const { rate8h } = computeFundingRate(spotPrice, twapPrice);

    // Clamp to +-1% (+-100 bps) per on-chain MAX_FUNDING_RATE_BPS
    const rateBps = Math.max(-100, Math.min(100, Math.round(rate8h * 100)));
    if (rateBps === 0) {
      log.info("funding crank: rate is 0, skipping settlement");
      fundingCrankStats.lastRunAt = Date.now();
      fundingCrankStats.lastRateBps = 0;
      return;
    }

    // 3. Check if enough time has passed (on-chain also enforces this)
    const [configPda] = findConfigPda();
    const configAcct = await connection.getAccountInfo(configPda);
    if (configAcct) {
      const config = decodeGlobalConfig(configAcct.data);
      const lastFundingAt = Number(config.lastFundingAt ?? 0n);
      const now = Math.floor(Date.now() / 1000);
      if (now - lastFundingAt < 28_800) {
        log.info({ elapsed: now - lastFundingAt }, "funding crank: too soon since last settlement");
        return;
      }
    }

    // 4. Fetch all open positions
    const positions = await fetchOpenPositions();
    if (positions.length === 0) {
      log.info("funding crank: no open positions");
      fundingCrankStats.lastRunAt = Date.now();
      return;
    }

    log.info({ rateBps, positionCount: positions.length, twapPrice, spotPrice }, "funding crank: settling");

    // 5. Settle each position
    const cranker = loadKeypair();
    let settled = 0;

    for (const { owner } of positions) {
      try {
        const ix = buildSettleFundingIx({
          caller: cranker.publicKey,
          positionOwner: owner,
          fundingRateBps: BigInt(rateBps),
          pythPriceFeed: new PublicKey(configAcct ? decodeGlobalConfig(configAcct.data).pythSolFeed : "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),
        });

        const { blockhash } = await connection.getLatestBlockhash();
        const msg = new TransactionMessage({
          payerKey: cranker.publicKey,
          recentBlockhash: blockhash,
          instructions: [
            ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
            ix,
          ],
        }).compileToV0Message();

        const tx = new VersionedTransaction(msg);
        tx.sign([cranker]);
        const sig = await connection.sendTransaction(tx, { skipPreflight: false });
        await connection.confirmTransaction(sig, "confirmed");
        settled++;
        log.info({ owner: owner.toBase58(), sig }, "funding settled");
      } catch (e: any) {
        // FundingTooSoon is expected if another crank already settled this round
        if (e.message?.includes("FundingTooSoon")) {
          log.debug({ owner: owner.toBase58() }, "funding already settled for this period");
        } else {
          log.warn({ owner: owner.toBase58(), err: e.message }, "funding settlement failed");
          fundingCrankStats.errors++;
        }
      }
    }

    fundingCrankStats.lastRunAt = Date.now();
    fundingCrankStats.positionsSettled += settled;
    fundingCrankStats.lastRateBps = rateBps;
    log.info({ settled, total: positions.length, rateBps }, "funding crank round complete");
  } catch (e: any) {
    log.error({ err: e.message }, "funding crank round failed");
    fundingCrankStats.errors++;
  }
}

export function startFundingCrank(): void {
  // Run first round after 30 seconds (let TWAP collector gather initial samples)
  setTimeout(() => {
    runFundingRound();
    // Then every 8 hours
    setInterval(runFundingRound, FUNDING_INTERVAL_MS);
  }, 30_000);
  log.info("funding crank service started (8h interval)");
}

// Allow standalone execution
if (require.main === module) {
  runFundingRound().then(() => process.exit(0)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
