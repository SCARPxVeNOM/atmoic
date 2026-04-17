import { ComputeBudgetProgram, PublicKey, Transaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import pino from "pino";

import { connection, loadKeypair, programId } from "../lib/connection";
import { env } from "../lib/env";
import { findConfigPda } from "../lib/pdas";
import { decodeGlobalConfig, decodePosition, PositionData } from "../lib/decode";
import { computeHealth } from "../lib/health";
import { fetchLatestPrice } from "../lib/pyth";
import { buildLiquidateIx } from "../lib/ix-builders";
import { buildKaminoRepay, extractIxForCpi } from "../lib/kamino";

import { requiresGracePeriod, getGracePeriodMs } from "../lib/haircuts";

const log = pino({ transport: { target: "pino-pretty" } } as any);

// Warning at 120% health (before 100% liquidation threshold)
const WARNING_THRESHOLD_BPS = 12_000n;

// Track when positions became unhealthy (for JLP grace period)
const unhealthySince: Map<string, number> = new Map();
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1000;

// Stats for /liquidator/status endpoint
export const liquidatorStats = {
  lastScanAt: 0,
  positionsScanned: 0,
  positionsWarned: 0,
  positionsLiquidated: 0,
  lastError: null as string | null,
};

// Matches utils/account.rs POSITION_DISCRIMINATOR
const POSITION_DISCRIMINATOR = Buffer.from([0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8]);

/** Scan all open positions via getProgramAccounts, filtered by account discriminator. */
async function fetchOpenPositions(): Promise<{ pubkey: PublicKey; data: PositionData }[]> {
  const accounts = await connection.getProgramAccounts(programId, {
    filters: [
      { memcmp: { offset: 0, bytes: bs58Encode(POSITION_DISCRIMINATOR) } },
    ],
  });
  const out: { pubkey: PublicKey; data: PositionData }[] = [];
  for (const a of accounts) {
    try {
      const data = decodePosition(a.account.data);
      if (data.isOpen) out.push({ pubkey: a.pubkey, data });
    } catch (e) {
      log.warn({ err: String(e), account: a.pubkey.toBase58() }, "decode failed");
    }
  }
  return out;
}

// Minimal base58 encoder to avoid extra dep in this file.
function bs58Encode(b: Buffer): string {
  // @ts-ignore
  const bs58 = require("bs58");
  return bs58.default ? bs58.default.encode(b) : bs58.encode(b);
}

export async function runLiquidatorOnce(): Promise<void> {
  const [configPda] = findConfigPda();
  const configAcct = await connection.getAccountInfo(configPda);
  if (!configAcct) {
    log.error("GlobalConfig not found — is the program initialized?");
    return;
  }
  const config = decodeGlobalConfig(configAcct.data);

  const { price6dp } = await fetchLatestPrice();

  const positions = await fetchOpenPositions();
  liquidatorStats.lastScanAt = Date.now();
  liquidatorStats.positionsScanned = positions.length;
  log.info({ count: positions.length, solPrice: Number(price6dp) / 1e6 }, "scan");

  if (positions.length === 0) return;

  const liquidator = loadKeypair();
  let warned = 0;

  for (const { pubkey, data } of positions) {
    const health = computeHealth({
      position: data,
      solPrice6dp: price6dp,
      liquidationThresholdBps: config.liquidationThreshold,
    });

    const healthBps = BigInt(health.healthFactorBps.toString());

    // Warning zone: health between 100% and 120%
    if (healthBps < WARNING_THRESHOLD_BPS && !health.liquidatable) {
      warned++;
      log.warn(
        { position: pubkey.toBase58(), owner: data.owner.toBase58(), healthBps: healthBps.toString() },
        "position at risk — approaching liquidation"
      );
    }

    if (!health.liquidatable) {
      // Clear grace period tracking if position recovered
      unhealthySince.delete(pubkey.toBase58());
      continue;
    }

    // JLP grace period: must be unhealthy for ≥2 hours before liquidation
    // TODO: detect collateral type from position data when multi-collateral is on-chain
    const posKey = pubkey.toBase58();
    const collateralType = "SOL" as const; // Phase 3: will read from position
    if (requiresGracePeriod(collateralType)) {
      const now = Date.now();
      if (!unhealthySince.has(posKey)) {
        unhealthySince.set(posKey, now);
        log.info({ position: posKey, gracePeriodMs: getGracePeriodMs(collateralType) },
          "grace period started — deferring liquidation");
        continue;
      }
      const elapsed = now - unhealthySince.get(posKey)!;
      if (elapsed < getGracePeriodMs(collateralType)) {
        log.info({ position: posKey, elapsedMs: elapsed, remainingMs: getGracePeriodMs(collateralType) - elapsed },
          "grace period active — skipping liquidation");
        continue;
      }
    }

    log.warn(
      { position: pubkey.toBase58(), owner: data.owner.toBase58(), healthBps: healthBps.toString() },
      "liquidatable — sending tx"
    );

    const liquidatorSolAta = getAssociatedTokenAddressSync(config.solMint, liquidator.publicKey);
    const feeRecipientSolAta = getAssociatedTokenAddressSync(config.solMint, config.feeRecipient);

    // Build Kamino repay CPI data for debt repayment on liquidation
    let kaminoRepayData: Buffer | undefined;
    let kaminoRemainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] | undefined;
    try {
      const repayBundle = await buildKaminoRepay(data.owner, config.usdcMint, data.borrowAmountUsdc);
      const extracted = extractIxForCpi(repayBundle.lendingIx);
      kaminoRepayData = extracted.data;
      kaminoRemainingAccounts = [
        { pubkey: extracted.programId, isSigner: false, isWritable: false },
        ...extracted.accounts,
      ];
    } catch (e) {
      log.warn({ err: String(e) }, "kamino repay build failed — liquidating without CPI repay");
    }

    const ix = buildLiquidateIx({
      liquidator: liquidator.publicKey,
      positionOwner: data.owner,
      solVault: config.solVault,
      liquidatorSolAccount: liquidatorSolAta,
      feeRecipientSolAccount: feeRecipientSolAta,
      pythPriceFeed: config.pythSolFeed,
      kaminoRepayData,
      kaminoRemainingAccounts,
    });

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ix
    );

    // Retry with exponential backoff
    let sent = false;
    for (let attempt = 0; attempt < MAX_RETRIES && !sent; attempt++) {
      try {
        const sig = await connection.sendTransaction(tx, [liquidator], { skipPreflight: false });
        log.info({ sig, position: pubkey.toBase58(), attempt }, "liquidate submitted");
        liquidatorStats.positionsLiquidated++;
        sent = true;
      } catch (e) {
        log.error({ err: String(e), position: pubkey.toBase58(), attempt }, "liquidate failed");
        liquidatorStats.lastError = String(e);
        if (attempt < MAX_RETRIES - 1) {
          await new Promise(r => setTimeout(r, RETRY_BASE_MS * Math.pow(2, attempt)));
        }
      }
    }
  }
  liquidatorStats.positionsWarned = warned;
}

export async function startLiquidator(): Promise<void> {
  log.info({ pollMs: env.liquidatorPollMs }, "liquidator starting");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runLiquidatorOnce();
    } catch (e) {
      log.error({ err: String(e) }, "scan failed");
    }
    await new Promise((r) => setTimeout(r, env.liquidatorPollMs));
  }
}

if (require.main === module) {
  startLiquidator().catch((e) => {
    log.error({ err: String(e) }, "fatal");
    process.exit(1);
  });
}
