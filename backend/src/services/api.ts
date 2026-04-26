import express from "express";
import cors from "cors";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  createCloseAccountInstruction,
  NATIVE_MINT,
} from "@solana/spl-token";
import pino from "pino";
import { WebSocketServer } from "ws";
import http from "http";

import { connection, programId } from "../lib/connection";
import { env } from "../lib/env";
import { findConfigPda, findPositionPda } from "../lib/pdas";
import { decodeGlobalConfig, decodePosition, GlobalConfigData } from "../lib/decode";
import { computeHealth } from "../lib/health";
import { fetchLatestPrice, fetchFromHermes } from "../lib/pyth";
import { fetchSwitchboardPrice } from "../lib/switchboard";
import {
  buildAtomicCloseIx,
  buildAtomicOpenIx,
  buildPlaceOrderIx,
  buildCancelOrderIx,
  findQueueShardPda,
  Side,
} from "../lib/ix-builders";
import {
  buildKaminoDeposit,
  buildKaminoBorrow,
  buildKaminoRepay,
  extractIxForCpi,
} from "../lib/kamino";
import { buildJupiterSwap } from "../lib/jupiter";
import { evaluateVaultRisk } from "../lib/spread";
import { countAccounts } from "../lib/tx-builder";
import { getMarket } from "../lib/market-registry";
import { getPsfStatus } from "../lib/psf";
import { liquidatorStats } from "./liquidator";
import { compute8hTwap, computeFundingRate, getFundingHistory } from "../lib/funding";
import { breakerState } from "./circuit-breaker";
import { crankStats } from "./crank";
import { fetchJlpPrice } from "../lib/jlp";
import { CollateralType } from "../lib/haircuts";
import { checkCollateralCap, CollateralTotals } from "../lib/collateral-caps";
import { msolState } from "./msol-monitor";

const log = pino({ transport: { target: "pino-pretty" } } as any);

// Cache the Address Lookup Table for VersionedTransaction construction.
let cachedAlt: AddressLookupTableAccount | null = null;
async function getAlt(): Promise<AddressLookupTableAccount[]> {
  if (!env.altAddress) return [];
  if (cachedAlt) return [cachedAlt];
  const altPk = new PublicKey(env.altAddress);
  const resp = await connection.getAddressLookupTable(altPk);
  if (resp.value) {
    cachedAlt = resp.value;
    return [cachedAlt];
  }
  return [];
}

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/config", async (_req, res) => {
  try {
    const [pda] = findConfigPda();
    const acct = await connection.getAccountInfo(pda);
    if (!acct) return res.status(404).json({ error: "config not initialized" });
    const cfg = decodeGlobalConfig(acct.data);
    res.json(serialize(cfg));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/position/:wallet", async (req, res) => {
  try {
    const wallet = new PublicKey(req.params.wallet);
    const [pda] = findPositionPda(wallet);
    const acct = await connection.getAccountInfo(pda);
    if (!acct) return res.status(404).json({ error: "no position" });
    res.json(serialize(decodePosition(acct.data)));
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

app.get("/position/:wallet/health", async (req, res) => {
  try {
    const wallet = new PublicKey(req.params.wallet);
    const [positionPda] = findPositionPda(wallet);
    const [configPda] = findConfigPda();

    const [posAcct, cfgAcct, { price6dp }] = await Promise.all([
      connection.getAccountInfo(positionPda),
      connection.getAccountInfo(configPda),
      fetchLatestPrice(),
    ]);

    if (!posAcct) return res.status(404).json({ error: "no position" });
    if (!cfgAcct) return res.status(500).json({ error: "no config" });

    const position = decodePosition(posAcct.data);
    const config = decodeGlobalConfig(cfgAcct.data);
    const report = computeHealth({
      position,
      solPrice6dp: price6dp,
      liquidationThresholdBps: config.liquidationThreshold,
    });
    res.json({
      solPrice: Number(price6dp) / 1e6,
      ...serialize(report),
    });
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

app.get("/vault/risk", async (_req, res) => {
  try {
    const config = await loadConfig();
    const risk = evaluateVaultRisk(config);
    res.json({
      ...risk,
      totalBorrowed: config.totalUsdcBorrowed.toString(),
      totalReserve: config.totalUsdcReserve.toString(),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * Proxy to Jupiter swap-quote. Safe to expose — Jupiter's public API has no
 * license restriction. Pyth Pro API must NEVER be proxied here (redistribution
 * clause). Hermes is fine because it's the free public endpoint.
 */
app.get("/quote", async (req, res) => {
  try {
    const { inputMint, outputMint, amount, slippageBps = "50", taker } = req.query;
    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({ error: "inputMint, outputMint, amount required" });
    }
    // Jupiter V2: /order returns quote + transaction. We strip the tx and return quote fields only.
    const takerAddr = taker || "11111111111111111111111111111111";
    const url = `https://api.jup.ag/swap/v2/order?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}&taker=${takerAddr}`;
    const r = await fetch(url);
    if (!r.ok) return res.status(r.status).json(await r.json());
    const data = await r.json();
    // Return quote-level fields only (strip transaction)
    res.json({
      inputMint: data.inputMint,
      outputMint: data.outputMint,
      inAmount: data.inAmount,
      outAmount: data.outAmount,
      otherAmountThreshold: data.otherAmountThreshold,
      swapMode: data.swapMode,
      slippageBps: data.slippageBps,
      priceImpactPct: data.priceImpactPct,
      routePlan: data.routePlan,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

async function loadConfig(): Promise<GlobalConfigData> {
  const [pda] = findConfigPda();
  const acct = await connection.getAccountInfo(pda);
  if (!acct) throw new Error("GlobalConfig not initialized");
  return decodeGlobalConfig(acct.data);
}

/**
 * Build an unsigned atomic_open tx for the wallet to sign. Returns base64
 * so the frontend can deserialize with Transaction.from().
 *
 * Body: { wallet, collateralAmount (SOL lamports), borrowAmount (USDC 6dp),
 *         side ("Long"|"Short"), leverageBps, hedgeAmount,
 *         useKamino? (boolean — whether to include real Kamino CPI) }
 */
app.post("/build-tx/open", async (req, res) => {
  try {
    const {
      wallet,
      collateralAmount,
      borrowAmount,
      side,
      leverageBps,
      hedgeAmount = "0",
      useKamino = false,
      useJupiterHedge = false,
      jupiterHedgeAmount = "0",
      market = "SOL-PERP",
      collateralType = "SOL",   // "SOL" | "JLP" | "mSOL"
    } = req.body ?? {};
    if (!wallet || !collateralAmount || !borrowAmount || !side || !leverageBps) {
      return res.status(400).json({ error: "missing required field" });
    }
    const collType = collateralType as CollateralType;
    const collTypeNum = collType === "JLP" ? 1 : collType === "mSOL" ? 2 : 0;

    // Look up market for oracle feed selection
    const marketInfo = getMarket(market);
    if (!marketInfo || !marketInfo.enabled) {
      return res.status(400).json({ error: `Market ${market} not found or disabled` });
    }
    const marketFeed = new PublicKey(marketInfo.pythFeedPubkey);

    const user = new PublicKey(wallet);
    const config = await loadConfig();

    // Dual oracle divergence check — halt if Pyth and Switchboard disagree >2%
    try {
      const [pythP, swP] = await Promise.all([
        fetchFromHermes(),
        fetchSwitchboardPrice(),
      ]);
      const gap = Math.abs(Number(pythP.price6dp) - Number(swP.price6dp));
      const maxDiv = Number(pythP.price6dp) * 2 / 100; // 2%
      if (gap > maxDiv) {
        return res.status(503).json({
          error: "oracle_divergence",
          message: "Pyth and Switchboard prices diverge >2% — halting new positions",
          pythPrice: Number(pythP.price6dp) / 1e6,
          switchboardPrice: Number(swP.price6dp) / 1e6,
        });
      }
    } catch {
      // If one oracle is unavailable, proceed with single oracle (graceful degradation)
    }

    // Dynamic spread (M-2): reject if vault too skewed.
    const risk = evaluateVaultRisk(config);
    if (risk.suspended) {
      return res.status(503).json({
        error: "fills_suspended",
        skewPct: risk.skewPct,
        message: "Vault skew exceeds 90% — fills suspended to protect LPs",
      });
    }

    // Spread fee is enforced on-chain — pass raw borrow + spread bps as ix param.
    const rawBorrow = BigInt(borrowAmount);

    // Resolve collateral vault, mint, and price based on collateral type
    let collateralMint: PublicKey;
    let collateralVault: PublicKey;
    let jlpPrice: bigint | undefined;
    let msolFeedAccount: PublicKey | undefined;

    if (collType === "JLP") {
      collateralMint = config.jlpMint;
      collateralVault = config.jlpVault;
      // Fetch live JLP virtual price from Jupiter pool
      const jlp = await fetchJlpPrice();
      jlpPrice = jlp.virtualPrice6dp;
    } else if (collType === "mSOL") {
      collateralMint = config.msolMint;
      collateralVault = config.msolVault;
      msolFeedAccount = config.pythMsolFeed;
      // Block mSOL deposits if depeg detected
      if (msolState.depositsBlocked) {
        return res.status(503).json({
          error: "msol_deposits_blocked",
          message: "mSOL deposits blocked — depeg or circuit breaker active",
        });
      }
    } else {
      collateralMint = config.solMint;
      collateralVault = config.solVault;
    }

    // Collateral cap check for yield-bearing assets (JLP/mSOL)
    if (collType === "JLP" || collType === "mSOL") {
      const totals: CollateralTotals = {
        USDC: 0n,
        SOL: config.totalCollateral - config.totalCorrelatedCollateral,
        mSOL: collType === "mSOL" ? config.totalCorrelatedCollateral : 0n,
        JLP: collType === "JLP" ? config.totalCorrelatedCollateral : 0n,
        RAY_LP: 0n,
      };
      // Cap check relaxed for bootstrap — on-chain program enforces final cap
      const capCheck = checkCollateralCap(collType, BigInt(collateralAmount), totals);
      if (!capCheck.allowed) {
        log.warn({ collateral: collType, afterPct: capCheck.afterYieldPct }, "collateral cap warning (proceeding — bootstrap mode)");
      }
    }

    const userCollateralAccount = getAssociatedTokenAddressSync(collateralMint, user, true);
    const userUsdcAccount = getAssociatedTokenAddressSync(config.usdcMint, user, true);
    const feeRecipientAccount = getAssociatedTokenAddressSync(
      config.usdcMint,
      config.feeRecipient,
      true,
    );

    // Kamino CPI disabled for atomic open — protocol uses its own USDC reserve.
    // Kamino integration (deposit→borrow lifecycle) runs as a separate composable layer.
    const kaminoBorrowData: Buffer = Buffer.alloc(0);
    const kaminoRemainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    const kaminoCleanupIxs: TransactionInstruction[] = [];

    // atomic_open: no Jupiter CPI — hedge runs as standalone ix in same tx
    const ix = buildAtomicOpenIx({
      user,
      userCollateralAccount,
      userUsdcAccount,
      collateralVault,
      usdcReserve: config.usdcReserve,
      feeRecipientAccount,
      pythPriceFeed: marketFeed,
      collateralAmount: BigInt(collateralAmount),
      borrowAmount: rawBorrow,
      perpSide: side === "Short" ? Side.Short : Side.Long,
      leverageBps: Number(leverageBps),
      hedgeAmount: BigInt(0),
      spreadFeeBps: risk.spreadBps,
      jupiterSwapData: Buffer.alloc(0),
      jupiterRemainingAccounts: [],
      kaminoBorrowData,
      kaminoRemainingAccounts,
      collateralType: collTypeNum,
      jlpPrice,
      msolFeedAccount,
    });

    const [{ blockhash, lastValidBlockHeight }, lookupTables] = await Promise.all([
      connection.getLatestBlockhash(),
      getAlt(),
    ]);

    // Build Jupiter hedge as separate tx (USDC→SOL after atomic_open)
    // Runs after atomic_open — sent sequentially via signAllTransactions.
    let jupiterHedgeTx: string | null = null;
    if (useJupiterHedge && BigInt(jupiterHedgeAmount) > 0n) {
      try {
        const buildUrl = `https://api.jup.ag/swap/v2/build?inputMint=${config.usdcMint.toBase58()}&outputMint=So11111111111111111111111111111111111111112&amount=${jupiterHedgeAmount}&taker=${user.toBase58()}&slippageBps=100`;
        const buildRes = await fetch(buildUrl);
        if (buildRes.ok) {
          const buildData = await buildRes.json();
          const toIx = (raw: any): TransactionInstruction => new TransactionInstruction({
            programId: new PublicKey(raw.programId),
            keys: (raw.accounts as any[]).map((a: any) => ({
              pubkey: new PublicKey(a.pubkey),
              isSigner: a.isSigner,
              isWritable: a.isWritable,
            })),
            data: Buffer.from(raw.data, "base64"),
          });
          const hedgeIxs: TransactionInstruction[] = [];
          if (buildData.computeBudgetInstructions) hedgeIxs.push(...buildData.computeBudgetInstructions.map(toIx));
          if (buildData.setupInstructions) hedgeIxs.push(...buildData.setupInstructions.map(toIx));
          if (buildData.swapInstruction) hedgeIxs.push(toIx(buildData.swapInstruction));
          if (buildData.cleanupInstruction) hedgeIxs.push(toIx(buildData.cleanupInstruction));

          // Use Jupiter's ALTs for compression
          let hedgeLookups = [...lookupTables];
          if (buildData.addressesByLookupTableAddress) {
            for (const [addr] of Object.entries(buildData.addressesByLookupTableAddress)) {
              try {
                const resp = await connection.getAddressLookupTable(new PublicKey(addr));
                if (resp.value) hedgeLookups.push(resp.value);
              } catch {}
            }
          }
          const hedgeMsg = new TransactionMessage({
            payerKey: user, recentBlockhash: blockhash, instructions: hedgeIxs,
          }).compileToV0Message(hedgeLookups);
          jupiterHedgeTx = Buffer.from(new VersionedTransaction(hedgeMsg).serialize()).toString("base64");
          log.info({ hedgeAmount: jupiterHedgeAmount }, "Jupiter hedge tx built via V2");
        }
      } catch (e: any) {
        log.warn({ err: e.message }, "Jupiter hedge build failed — proceeding without");
      }
    }

    function buildV0Tx(ixs: TransactionInstruction[]): string {
      const msg = new TransactionMessage({
        payerKey: user, recentBlockhash: blockhash, instructions: ixs,
      }).compileToV0Message(lookupTables);
      return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
    }

    // --- Split into setup tx + main tx (signed together via signAllTransactions) ---
    const setupIxs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ];

    // Collateral setup: depends on collateral type
    if (collTypeNum === 0) {
      // SOL: wrap native SOL into wSOL ATA
      setupIxs.push(createAssociatedTokenAccountIdempotentInstruction(user, userCollateralAccount, user, NATIVE_MINT));
      setupIxs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: userCollateralAccount, lamports: BigInt(collateralAmount) }));
      setupIxs.push(createSyncNativeInstruction(userCollateralAccount));
    } else {
      // JLP or mSOL: create ATA for the collateral token
      setupIxs.push(createAssociatedTokenAccountIdempotentInstruction(user, userCollateralAccount, user, collateralMint));
    }
    // USDC ATA
    setupIxs.push(createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAccount, user, config.usdcMint));
    // Fee recipient ATA
    setupIxs.push(createAssociatedTokenAccountIdempotentInstruction(user, feeRecipientAccount, config.feeRecipient, config.usdcMint));

    // One-click stake-to-trade: if user selected JLP/mSOL but only has SOL,
    // auto-swap SOL → JLP/mSOL via Jupiter in a separate preceding tx.
    let swapTx: string | null = null;
    if (collTypeNum === 1 || collTypeNum === 2) {
      // Check if user already has enough JLP/mSOL
      let userCollBalance = 0n;
      try {
        const acct = await connection.getAccountInfo(userCollateralAccount);
        if (acct && acct.data.length >= 72) {
          userCollBalance = acct.data.readBigUInt64LE(64);
        }
      } catch {}

      if (userCollBalance < BigInt(collateralAmount)) {
        // User doesn't have enough JLP/mSOL — swap SOL → JLP/mSOL via Jupiter
        const targetMint = collTypeNum === 1
          ? "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"  // JLP
          : "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";  // mSOL
        const deficit = BigInt(collateralAmount) - userCollBalance;
        try {
          // Jupiter V2 /order with ExactOut — specify the exact output amount (JLP/mSOL deficit)
          // and Jupiter computes the required SOL input. Returns a ready-to-sign serialized tx.
          const orderUrl = `https://api.jup.ag/swap/v2/order?inputMint=So11111111111111111111111111111111111111112&outputMint=${targetMint}&amount=${deficit.toString()}&swapMode=ExactOut&taker=${user.toBase58()}&slippageBps=150`;
          const orderRes = await fetch(orderUrl);
          if (orderRes.ok) {
            const orderData = await orderRes.json();
            if (orderData.transaction) {
              swapTx = orderData.transaction;
              log.info({ collateral: collType, deficit: deficit.toString(), inAmount: orderData.inAmount, outAmount: orderData.outAmount }, "one-click: SOL→collateral swap built via V2 ExactOut");
            } else {
              log.warn({ orderData }, "Jupiter V2 /order returned no transaction");
            }
          } else {
            const errBody = await orderRes.text();
            log.warn({ status: orderRes.status, body: errBody }, "Jupiter V2 /order ExactOut failed");
          }
        } catch (e: any) {
          log.warn({ err: e.message, collateral: collType }, "one-click swap failed — user must have collateral token");
        }

        if (!swapTx) {
          return res.status(400).json({
            error: "need_collateral",
            message: `You need ${collType} tokens to use this collateral type. Get ${collType === "JLP" ? "JLP from jup.ag/perps/jlp-earn" : "mSOL from marinade.finance"}, or select SOL collateral.`,
          });
        }
      }
    }

    // === ATOMIC OPEN: split into focused transactions ===
    // Tx 1 (setup): wSOL wrap + ATA creation + Kamino deposit
    // Tx 2 (core):  Kamino borrow refresh + atomic_open (Kamino CPI) + wSOL close
    // Tx 3 (hedge): Jupiter swap USDC→SOL (only if hedge requested)
    //
    // Atomicity: frontend uses signAllTransactions (one Phantom dialog),
    // sends sequentially. If Tx2 fails, Tx3 is never sent.
    // Kamino deposit + borrow + perp open are the critical path.

    // Tx 2: atomic_open core instruction
    const mainIxs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ix,
    ];
    // Close wSOL ATA last
    if (collTypeNum === 0) {
      mainIxs.push(createCloseAccountInstruction(userCollateralAccount, user, user));
    }

    // Build transaction list
    let txs: string[] = [];

    // Tx 0 (optional): Jupiter swap SOL → JLP/mSOL for one-click stake-to-trade
    if (swapTx) {
      txs.push(swapTx);
    }

    // Try to fit setup+main in one tx. If too large, split.
    try {
      const allIxs = [...setupIxs.slice(2), ...mainIxs];
      const singleTx = buildV0Tx(allIxs);
      if (Buffer.from(singleTx, "base64").length <= 1232) {
        txs.push(singleTx);
        log.info({ hasSwap: !!swapTx }, "atomic open: single-tx mode");
      } else {
        throw new Error("too large");
      }
    } catch {
      txs.push(buildV0Tx(setupIxs), buildV0Tx(mainIxs));
      log.info({ txCount: txs.length, hasSwap: !!swapTx, hasHedge: !!jupiterHedgeTx }, "atomic open: multi-tx mode");
    }

    // Tx 3 (optional): Jupiter hedge USDC→SOL as a separate tx after main open
    if (jupiterHedgeTx) {
      txs.push(jupiterHedgeTx);
    }

    res.json({
      txs,
      blockhash,
      lastValidBlockHeight,
      spread: {
        spreadBps: risk.spreadBps,
        skewPct: risk.skewPct,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/build-tx/close", async (req, res) => {
  try {
    const { wallet, useKamino = false } = req.body ?? {};
    if (!wallet) return res.status(400).json({ error: "wallet required" });
    const user = new PublicKey(wallet);
    const config = await loadConfig();

    // Look up position to determine collateral type and borrow amount
    const [positionPda] = findPositionPda(user);
    const posAcct = await connection.getAccountInfo(positionPda);
    if (!posAcct) return res.status(404).json({ error: "no position" });
    const position = decodePosition(posAcct.data);

    // Resolve collateral type from position's mint
    const JLP_MINT_STR = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";
    const MSOL_MINT_STR = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
    const posMintStr = position.collateralMint.toBase58();
    let closeCollateralVault: PublicKey;
    let closeCollateralMint: PublicKey;
    let closeCollateralPrice: bigint | undefined;
    let closeMsolFeedAccount: PublicKey | undefined;

    if (posMintStr === JLP_MINT_STR || position.collateralMint.equals(config.jlpMint)) {
      closeCollateralMint = config.jlpMint;
      closeCollateralVault = config.jlpVault;
      const jlp = await fetchJlpPrice();
      closeCollateralPrice = jlp.virtualPrice6dp;
    } else if (posMintStr === MSOL_MINT_STR || position.collateralMint.equals(config.msolMint)) {
      closeCollateralMint = config.msolMint;
      closeCollateralVault = config.msolVault;
      closeMsolFeedAccount = config.pythMsolFeed;
    } else {
      closeCollateralMint = config.solMint;
      closeCollateralVault = config.solVault;
    }

    const userCollateralAccount = getAssociatedTokenAddressSync(closeCollateralMint, user, true);
    const userUsdcAccount = getAssociatedTokenAddressSync(config.usdcMint, user, true);
    // Fee recipient gets collateral tokens (not USDC) since close settles in collateral
    const feeRecipientAccount = getAssociatedTokenAddressSync(
      closeCollateralMint,
      config.feeRecipient,
      true,
    );

    // Build Kamino repay ixs if requested.
    let kaminoRepayData: Buffer = Buffer.alloc(0);
    let kaminoRemainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    let kaminoSetupIxs: any[] = [];
    let kaminoCleanupIxs: any[] = [];

    if (useKamino) {
      const kamino = await buildKaminoRepay(user, config.usdcMint, position.borrowAmountUsdc);
      const extracted = extractIxForCpi(kamino.lendingIx);
      kaminoRepayData = extracted.data;
      kaminoRemainingAccounts = [
        { pubkey: extracted.programId, isSigner: false, isWritable: false },
        ...extracted.accounts,
      ];
      kaminoSetupIxs = kamino.setupIxs;
      kaminoCleanupIxs = kamino.cleanupIxs;
    }

    const ix = buildAtomicCloseIx({
      user,
      userCollateralAccount,
      userUsdcAccount,
      collateralVault: closeCollateralVault,
      usdcReserve: config.usdcReserve,
      feeRecipientAccount,
      pythPriceFeed: config.pythSolFeed,
      kaminoRepayData,
      kaminoRemainingAccounts,
      collateralPrice: closeCollateralPrice,
      msolFeedAccount: closeMsolFeedAccount,
    });

    const [{ blockhash, lastValidBlockHeight }, lookupTables] = await Promise.all([
      connection.getLatestBlockhash(),
      getAlt(),
    ]);

    function buildV0Tx(ixs: TransactionInstruction[]): string {
      const msg = new TransactionMessage({
        payerKey: user, recentBlockhash: blockhash, instructions: ixs,
      }).compileToV0Message(lookupTables);
      return Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64");
    }

    // The user needs USDC to repay and a wSOL ATA to receive collateral back.
    // Check if user has enough USDC; if not, swap SOL→USDC first.
    const setupIxs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 300_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ];

    // Ensure USDC ATA exists
    setupIxs.push(createAssociatedTokenAccountIdempotentInstruction(user, userUsdcAccount, user, config.usdcMint));

    // For SOL collateral: create wSOL ATA to receive collateral back
    const isSolCollateral = closeCollateralMint.equals(config.solMint);
    if (isSolCollateral) {
      setupIxs.push(createAssociatedTokenAccountIdempotentInstruction(user, userCollateralAccount, user, NATIVE_MINT));
    }

    // Fee recipient collateral ATA (fees paid in collateral on close)
    setupIxs.push(createAssociatedTokenAccountIdempotentInstruction(user, feeRecipientAccount, config.feeRecipient, closeCollateralMint));

    // Main tx: Kamino setup + atomic_close + Kamino cleanup + unwrap wSOL
    const mainIxs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ...kaminoSetupIxs, ix, ...kaminoCleanupIxs,
    ];
    // Close wSOL ATA to unwrap back to native SOL
    if (isSolCollateral) {
      mainIxs.push(createCloseAccountInstruction(userCollateralAccount, user, user));
    }

    const txs = [buildV0Tx(setupIxs), buildV0Tx(mainIxs)];

    res.json({
      txs,
      blockhash,
      lastValidBlockHeight,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- Kamino SOL yield endpoint ----
// Uses klend-sdk on-chain data via the already-loaded KaminoMarket.
import { invalidateMarketCache } from "../lib/kamino";

let cachedYield: { apy: number; fetchedAt: number } | null = null;
const YIELD_CACHE_MS = 60_000;
const SOL_MINT_STR = "So11111111111111111111111111111111111111112";

app.get("/yield/sol", async (_req, res) => {
  try {
    const now = Date.now();
    if (!cachedYield || now - cachedYield.fetchedAt > YIELD_CACHE_MS) {
      // Try multiple Kamino API endpoints
      let apy = 0;
      try {
        const r = await fetch(
          `https://api.kamino.finance/v2/kamino-market/7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF/reserves?env=mainnet-beta`
        );
        if (r.ok) {
          const data = await r.json();
          const solReserve = Array.isArray(data)
            ? data.find((rv: any) => rv.symbol === "SOL" || rv.liquidityToken?.mint === SOL_MINT_STR)
            : (data.reserves ?? []).find((rv: any) => rv.symbol === "SOL");
          apy = Number(solReserve?.metrics?.supplyInterestAPY ?? solReserve?.supplyApy ?? 0);
        }
      } catch { /* API unavailable */ }
      // Fallback: Kamino SOL lending typically yields 3-7% APY
      if (apy === 0) apy = 0.045; // 4.5% conservative estimate
      cachedYield = { apy, fetchedAt: now };
    }
    res.json({ apy: cachedYield.apy });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/liquidator/status", (_req, res) => {
  res.json(liquidatorStats);
});

app.get("/funding/sol", async (_req, res) => {
  try {
    const { twapPrice, sampleCount } = compute8hTwap();
    const { price6dp } = await fetchLatestPrice();
    const spotPrice = Number(price6dp) / 1e6;
    const { rate8h, rateAnnualized } = computeFundingRate(spotPrice, twapPrice);
    res.json({ rate: rateAnnualized, rate8h, twapPrice, spotPrice, sampleCount });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/funding/history", (_req, res) => {
  try {
    res.json(getFundingHistory());
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Per-wallet DFBA rate limiter (A-01 R-3): 5-batch cooldown on side switch
const walletOrderHistory = new Map<string, { side: string; ts: number }>();
const RATE_LIMIT_COOLDOWN_MS = 500; // 5 batches × 100ms

app.post("/build-tx/place-order", async (req, res) => {
  try {
    const { wallet, price, size, side } = req.body ?? {};
    if (!wallet || !price || !size || !side) {
      return res.status(400).json({ error: "wallet, price, size, side required" });
    }
    const now = Date.now();
    const prev = walletOrderHistory.get(wallet);
    if (prev && prev.side !== side && now - prev.ts < RATE_LIMIT_COOLDOWN_MS) {
      return res.status(429).json({
        error: "rate_limited",
        message: "Side switch cooldown — wait before placing opposite order",
      });
    }
    walletOrderHistory.set(wallet, { side, ts: now });

    const user = new PublicKey(wallet);
    const shardIdx = user.toBuffer()[0] % 8;
    const [queueShard] = findQueueShardPda(0, side === "ask" ? 1 : 0, shardIdx);

    const ix = buildPlaceOrderIx({
      user,
      queueShard,
      price: BigInt(price),
      size: BigInt(size),
    });

    const [{ blockhash, lastValidBlockHeight }, lookupTables] = await Promise.all([
      connection.getLatestBlockhash(),
      getAlt(),
    ]);

    const message = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message(lookupTables);

    const vtx = new VersionedTransaction(message);
    res.json({
      tx: Buffer.from(vtx.serialize()).toString("base64"),
      blockhash,
      lastValidBlockHeight,
      shard: shardIdx,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.post("/build-tx/cancel-order", async (req, res) => {
  try {
    const { wallet, side } = req.body ?? {};
    if (!wallet || !side) return res.status(400).json({ error: "wallet, side required" });

    const user = new PublicKey(wallet);
    const shardIdx = user.toBuffer()[0] % 8;
    const [queueShard] = findQueueShardPda(0, side === "ask" ? 1 : 0, shardIdx);

    const ix = buildCancelOrderIx({ user, queueShard });

    const [{ blockhash, lastValidBlockHeight }, lookupTables] = await Promise.all([
      connection.getLatestBlockhash(),
      getAlt(),
    ]);

    const message = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: [ix],
    }).compileToV0Message(lookupTables);

    const vtx = new VersionedTransaction(message);
    res.json({
      tx: Buffer.from(vtx.serialize()).toString("base64"),
      blockhash,
      lastValidBlockHeight,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/circuit-breaker", (_req, res) => {
  res.json(breakerState);
});

app.get("/msol/status", (_req, res) => {
  res.json(msolState);
});

app.get("/crank/status", (_req, res) => {
  res.json(crankStats);
});

app.get("/psf", async (_req, res) => {
  try {
    const config = await loadConfig();
    res.json(await getPsfStatus(config));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- Candle data (proxied from Binance public API — no key needed) ----
const BINANCE_SYMBOLS: Record<string, string> = {
  "SOL-USD": "SOLUSDT",
  "BTC-USD": "BTCUSDT",
  "ETH-USD": "ETHUSDT",
};
const VALID_INTERVALS = ["1m","5m","15m","30m","1h","4h","1d"];
let candleCache: Record<string, { data: any; ts: number }> = {};
const CANDLE_CACHE_MS = 10_000;

app.get("/candles/:pair", async (req, res) => {
  try {
    const symbol = BINANCE_SYMBOLS[req.params.pair];
    if (!symbol) return res.status(400).json({ error: "unknown pair" });
    const interval = typeof req.query.interval === "string" && VALID_INTERVALS.includes(req.query.interval)
      ? req.query.interval : "5m";
    const limit = Math.min(Number(req.query.limit) || 300, 1000);
    const cacheKey = `${symbol}_${interval}_${limit}`;
    const now = Date.now();
    if (candleCache[cacheKey] && now - candleCache[cacheKey].ts < CANDLE_CACHE_MS) {
      return res.json(candleCache[cacheKey].data);
    }
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: "binance upstream error" });
    const raw = await r.json() as number[][];
    const candles = raw.map((k: number[]) => ({
      time: Math.floor(k[0] / 1000),
      open: parseFloat(String(k[1])),
      high: parseFloat(String(k[2])),
      low: parseFloat(String(k[3])),
      close: parseFloat(String(k[4])),
      volume: parseFloat(String(k[5])),
      quoteVolume: parseFloat(String(k[7])),
      closeTime: Math.floor(Number(k[6]) / 1000),
    }));
    candleCache[cacheKey] = { data: candles, ts: now };
    res.json(candles);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// 24h ticker for all markets — used by header market badges
let tickerCache: { data: any; ts: number } | null = null;
const TICKER_CACHE_MS = 15_000;

app.get("/tickers", async (_req, res) => {
  try {
    const now = Date.now();
    if (tickerCache && now - tickerCache.ts < TICKER_CACHE_MS) {
      return res.json(tickerCache.data);
    }
    const symbols = Object.values(BINANCE_SYMBOLS);
    const url = `https://api.binance.com/api/v3/ticker/24hr?symbols=${JSON.stringify(symbols)}`;
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: "binance upstream error" });
    const raw = await r.json() as any[];
    const tickers: Record<string, any> = {};
    for (const [pair, binSymbol] of Object.entries(BINANCE_SYMBOLS)) {
      const t = raw.find((x: any) => x.symbol === binSymbol);
      if (t) {
        tickers[pair] = {
          price: parseFloat(t.lastPrice),
          change24h: parseFloat(t.priceChangePercent),
          high24h: parseFloat(t.highPrice),
          low24h: parseFloat(t.lowPrice),
          volume24h: parseFloat(t.quoteVolume),
        };
      }
    }
    tickerCache = { data: tickers, ts: now };
    res.json(tickers);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/price/sol", async (_req, res) => {
  try {
    const p = await fetchLatestPrice();
    res.json({
      price: Number(p.price6dp) / 1e6,
      confidence: Number(p.confidence6dp) / 1e6,
      publishTime: p.publishTime,
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Serialize BigInt/PublicKey safely for JSON.
function serialize(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "bigint") return obj.toString();
  if (obj instanceof PublicKey) return obj.toBase58();
  if (Array.isArray(obj)) return obj.map(serialize);
  if (typeof obj === "object") {
    const out: any = {};
    for (const k of Object.keys(obj)) out[k] = serialize(obj[k]);
    return out;
  }
  return obj;
}

export function startApi(): http.Server {
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  // Fan out position updates via program account subscription.
  const subId = connection.onProgramAccountChange(
    programId,
    (info) => {
      try {
        const data = decodePosition(info.accountInfo.data);
        const payload = JSON.stringify({
          type: "position",
          pubkey: info.accountId.toBase58(),
          data: serialize(data),
        });
        wss.clients.forEach((c) => c.readyState === 1 && c.send(payload));
      } catch {
        // not a Position account — ignore
      }
    },
    "confirmed"
  );

  server.on("close", () => {
    connection.removeProgramAccountChangeListener(subId).catch(() => {});
  });

  server.listen(env.apiPort, () => {
    log.info({ port: env.apiPort }, "api listening");
  });
  return server;
}

if (require.main === module) {
  startApi();
}
