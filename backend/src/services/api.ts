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
  buildSettleFundingIx,
  findQueueShardPda,
  Side,
} from "../lib/ix-builders";
import { evaluateVaultRisk } from "../lib/spread";
import { getMarket } from "../lib/market-registry";
import { getPsfStatus } from "../lib/psf";
import { liquidatorStats } from "./liquidator";
import { compute8hTwap, computeFundingRate, computeEnhancedFundingRate, getFundingHistory } from "../lib/funding";
import { breakerState } from "./circuit-breaker";
import { crankStats } from "./crank";
import { fundingCrankStats } from "./funding-crank";
import { getVpin, getVpinClassification } from "../lib/dfba";
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

// Fetch all positions for a wallet across all markets
app.get("/positions/:wallet", async (req, res) => {
  try {
    const wallet = new PublicKey(req.params.wallet);
    const accounts = await connection.getProgramAccounts(programId, {
      filters: [{ memcmp: { offset: 8, bytes: wallet.toBase58() } }],
    });
    const positions = accounts
      .map(a => decodePosition(a.account.data))
      .filter(p => p.isOpen)
      .map(p => serialize(p));
    res.json(positions);
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

// Fetch single position by wallet + market
app.get("/position/:wallet/:market?", async (req, res) => {
  try {
    const wallet = new PublicKey(req.params.wallet);
    const marketSymbol = req.params.market || "SOL-PERP";
    const marketInfo = getMarket(marketSymbol);
    if (!marketInfo) return res.status(400).json({ error: `Unknown market: ${marketSymbol}` });
    const marketFeed = new PublicKey(marketInfo.pythFeedPubkey);
    const [pda] = findPositionPda(wallet, marketFeed);
    const acct = await connection.getAccountInfo(pda);
    if (!acct) return res.status(404).json({ error: "no position" });
    res.json(serialize(decodePosition(acct.data)));
  } catch (e) {
    res.status(400).json({ error: String(e) });
  }
});

app.get("/position/:wallet/:market/health", async (req, res) => {
  try {
    const wallet = new PublicKey(req.params.wallet);
    const marketSymbol = req.params.market || "SOL-PERP";
    const marketInfo = getMarket(marketSymbol);
    if (!marketInfo) return res.status(400).json({ error: `Unknown market: ${marketSymbol}` });
    const marketFeed = new PublicKey(marketInfo.pythFeedPubkey);
    const [positionPda] = findPositionPda(wallet, marketFeed);
    const [configPda] = findConfigPda();

    const [posAcct, cfgAcct, { price6dp }] = await Promise.all([
      connection.getAccountInfo(positionPda),
      connection.getAccountInfo(configPda),
      fetchLatestPrice(marketInfo.pythFeedId),
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
      markPrice: Number(price6dp) / 1e6,
      market: marketSymbol,
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
    const vpin = getVpinClassification();
    res.json({
      ...risk,
      vpin,
      totalLongOi: config.totalLongOi.toString(),
      totalShortOi: config.totalShortOi.toString(),
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
 * Build an unsigned atomic_open tx for the wallet to sign.
 *
 * Pure margin perps: user deposits collateral, position is synthetic.
 * No USDC is borrowed or sent to the user.
 *
 * Body: { wallet, collateralAmount (native units), side ("Long"|"Short"),
 *         leverageBps, market?, collateralType? ("SOL"|"JLP"|"mSOL") }
 */
app.post("/build-tx/open", async (req, res) => {
  try {
    const {
      wallet,
      collateralAmount,
      side,
      leverageBps,
      market = "SOL-PERP",
      collateralType = "SOL",   // "SOL" | "JLP" | "mSOL"
    } = req.body ?? {};
    if (!wallet || !collateralAmount || !side || !leverageBps) {
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

    // Dynamic spread (M-2): directional skew check.
    const risk = evaluateVaultRisk(config);
    const tradeSide = (side as string).toLowerCase();
    if (risk.suspended && risk.blockedSide === tradeSide) {
      return res.status(503).json({
        error: "fills_suspended",
        skewPct: risk.skewPct,
        blockedSide: risk.blockedSide,
        message: `Vault skew exceeds 90% — ${risk.blockedSide} fills suspended. ${risk.blockedSide === "long" ? "Short" : "Long"} trades still accepted.`,
      });
    }

    // Resolve collateral vault, mint, and price based on collateral type
    let collateralMint: PublicKey;
    let collateralVault: PublicKey;
    let collateralPrice6dp: bigint | undefined;

    if (collType === "JLP") {
      collateralMint = config.jlpMint;
      collateralVault = config.jlpVault;
      const jlp = await fetchJlpPrice();
      collateralPrice6dp = jlp.virtualPrice6dp;
    } else if (collType === "mSOL") {
      collateralMint = config.msolMint;
      collateralVault = config.msolVault;
      if (msolState.depositsBlocked) {
        return res.status(503).json({
          error: "msol_deposits_blocked",
          message: "mSOL deposits blocked — depeg or circuit breaker active",
        });
      }
      const msolMint = "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
      const priceRes = await fetch(`https://api.jup.ag/price/v3?ids=${msolMint}`);
      if (priceRes.ok) {
        const priceData = await priceRes.json();
        if (priceData[msolMint]?.usdPrice) {
          collateralPrice6dp = BigInt(Math.round(Number(priceData[msolMint].usdPrice) * 1e6));
        }
      }
      if (!collateralPrice6dp) {
        return res.status(503).json({ error: "msol_price_unavailable", message: "Could not fetch mSOL price" });
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
      const capCheck = checkCollateralCap(collType, BigInt(collateralAmount), totals);
      if (!capCheck.allowed) {
        log.warn({ collateral: collType, afterPct: capCheck.afterYieldPct }, "collateral cap warning (proceeding — bootstrap mode)");
      }
    }

    const userCollateralAccount = getAssociatedTokenAddressSync(collateralMint, user, true);
    // Fee recipient gets collateral tokens (not USDC) in pure perps model
    const feeRecipientAccount = getAssociatedTokenAddressSync(
      collateralMint,
      config.feeRecipient,
      true,
    );

    const ix = buildAtomicOpenIx({
      user,
      userCollateralAccount,
      collateralVault,
      feeRecipientAccount,
      pythPriceFeed: marketFeed,
      collateralAmount: BigInt(collateralAmount),
      perpSide: side === "Short" ? Side.Short : Side.Long,
      leverageBps: Number(leverageBps),
      spreadFeeBps: risk.spreadBps,
      collateralType: collTypeNum,
      collateralPrice: collateralPrice6dp,
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

    // Setup instructions: ATA creation + collateral wrapping
    const setupIxs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ];

    if (collTypeNum === 0) {
      // SOL: wrap native SOL into wSOL ATA
      setupIxs.push(createAssociatedTokenAccountIdempotentInstruction(user, userCollateralAccount, user, NATIVE_MINT));
      setupIxs.push(SystemProgram.transfer({ fromPubkey: user, toPubkey: userCollateralAccount, lamports: BigInt(collateralAmount) }));
      setupIxs.push(createSyncNativeInstruction(userCollateralAccount));
    } else {
      setupIxs.push(createAssociatedTokenAccountIdempotentInstruction(user, userCollateralAccount, user, collateralMint));
    }
    // Fee recipient collateral ATA
    setupIxs.push(createAssociatedTokenAccountIdempotentInstruction(user, feeRecipientAccount, config.feeRecipient, collateralMint));

    // One-click stake-to-trade: auto-swap SOL → JLP/mSOL if user doesn't have enough
    let swapTx: string | null = null;
    if (collTypeNum === 1 || collTypeNum === 2) {
      let userCollBalance = 0n;
      try {
        const acct = await connection.getAccountInfo(userCollateralAccount);
        if (acct && acct.data.length >= 72) {
          userCollBalance = acct.data.readBigUInt64LE(64);
        }
      } catch {}

      if (userCollBalance < BigInt(collateralAmount)) {
        const targetMint = collTypeNum === 1
          ? "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"
          : "mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So";
        const deficit = BigInt(collateralAmount) - userCollBalance;
        try {
          const orderUrl = `https://api.jup.ag/swap/v2/order?inputMint=So11111111111111111111111111111111111111112&outputMint=${targetMint}&amount=${deficit.toString()}&swapMode=ExactOut&taker=${user.toBase58()}&slippageBps=150`;
          const orderRes = await fetch(orderUrl);
          if (orderRes.ok) {
            const orderData = await orderRes.json();
            if (orderData.transaction) {
              swapTx = orderData.transaction;
              log.info({ collateral: collType, deficit: deficit.toString() }, "one-click: SOL→collateral swap built");
            }
          }
        } catch (e: any) {
          log.warn({ err: e.message, collateral: collType }, "one-click swap failed");
        }

        if (!swapTx) {
          return res.status(400).json({
            error: "need_collateral",
            message: `You need ${collType} tokens. Get ${collType === "JLP" ? "JLP from jup.ag/perps/jlp-earn" : "mSOL from marinade.finance"}, or select SOL collateral.`,
          });
        }
      }
    }

    // Main tx: atomic_open
    const mainIxs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ix,
    ];
    if (collTypeNum === 0) {
      mainIxs.push(createCloseAccountInstruction(userCollateralAccount, user, user));
    }

    let txs: string[] = [];
    if (swapTx) txs.push(swapTx);

    // Try single tx, fall back to split
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
      log.info({ txCount: txs.length, hasSwap: !!swapTx }, "atomic open: multi-tx mode");
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
    const { wallet, closeBps = 10000, market = "SOL-PERP" } = req.body ?? {};
    if (!wallet) return res.status(400).json({ error: "wallet required" });
    const user = new PublicKey(wallet);
    const config = await loadConfig();

    // Resolve market feed for PDA derivation
    const marketInfo = getMarket(market);
    if (!marketInfo || !marketInfo.enabled) {
      return res.status(400).json({ error: `Market ${market} not found or disabled` });
    }
    const marketFeed = new PublicKey(marketInfo.pythFeedPubkey);

    // Look up position to determine collateral type
    const [positionPda] = findPositionPda(user, marketFeed);
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

    if (posMintStr === JLP_MINT_STR || position.collateralMint.equals(config.jlpMint)) {
      closeCollateralMint = config.jlpMint;
      closeCollateralVault = config.jlpVault;
      const jlp = await fetchJlpPrice();
      closeCollateralPrice = jlp.virtualPrice6dp;
    } else if (posMintStr === MSOL_MINT_STR || position.collateralMint.equals(config.msolMint)) {
      closeCollateralMint = config.msolMint;
      closeCollateralVault = config.msolVault;
      const priceRes = await fetch(`https://api.jup.ag/price/v3?ids=${MSOL_MINT_STR}`);
      if (priceRes.ok) {
        const priceData = await priceRes.json();
        if (priceData[MSOL_MINT_STR]?.usdPrice) {
          closeCollateralPrice = BigInt(Math.round(Number(priceData[MSOL_MINT_STR].usdPrice) * 1e6));
        }
      }
      if (!closeCollateralPrice) {
        return res.status(503).json({ error: "msol_price_unavailable", message: "Could not fetch mSOL price for close" });
      }
    } else {
      closeCollateralMint = config.solMint;
      closeCollateralVault = config.solVault;
    }

    const userCollateralAccount = getAssociatedTokenAddressSync(closeCollateralMint, user, true);
    // Fee recipient gets collateral tokens in pure perps model
    const feeRecipientAccount = getAssociatedTokenAddressSync(
      closeCollateralMint,
      config.feeRecipient,
      true,
    );

    const ix = buildAtomicCloseIx({
      user,
      userCollateralAccount,
      collateralVault: closeCollateralVault,
      feeRecipientAccount,
      pythPriceFeed: marketFeed,
      closeBps: Number(closeBps),
      collateralPrice: closeCollateralPrice,
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

    const setupIxs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    ];

    // For SOL collateral: create wSOL ATA to receive collateral back
    const isSolCollateral = closeCollateralMint.equals(config.solMint);
    if (isSolCollateral) {
      setupIxs.push(createAssociatedTokenAccountIdempotentInstruction(user, userCollateralAccount, user, NATIVE_MINT));
    }

    // Fee recipient collateral ATA
    setupIxs.push(createAssociatedTokenAccountIdempotentInstruction(user, feeRecipientAccount, config.feeRecipient, closeCollateralMint));

    const mainIxs: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ix,
    ];
    if (isSolCollateral) {
      mainIxs.push(createCloseAccountInstruction(userCollateralAccount, user, user));
    }

    // Try single tx, fall back to split
    let txs: string[];
    try {
      const allIxs = [...setupIxs.slice(2), ...mainIxs];
      const singleTx = buildV0Tx(allIxs);
      if (Buffer.from(singleTx, "base64").length <= 1232) {
        txs = [singleTx];
      } else {
        throw new Error("too large");
      }
    } catch {
      txs = [buildV0Tx(setupIxs), buildV0Tx(mainIxs)];
    }

    res.json({
      txs,
      blockhash,
      lastValidBlockHeight,
      closeBps: Number(closeBps),
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---- Kamino SOL yield endpoint ----
// Uses klend-sdk on-chain data via the already-loaded KaminoMarket.

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

app.get("/funding/:market", async (req, res) => {
  try {
    const marketParam = req.params.market.toUpperCase();
    const symbol = marketParam.endsWith("-PERP") ? marketParam : `${marketParam}-PERP`;
    const marketInfo = getMarket(symbol);
    const feedId = marketInfo?.pythFeedId;

    const { twapPrice, sampleCount } = compute8hTwap();
    const config = await loadConfig();
    const { price6dp } = await fetchLatestPrice(feedId);
    const spotPrice = Number(price6dp) / 1e6;
    const { rate8h, rateAnnualized } = computeFundingRate(spotPrice, twapPrice);

    // Predictive rate with trend/skew/variance adjustments
    const enhanced = computeEnhancedFundingRate(
      spotPrice, twapPrice,
      Number(config.totalLongOi), Number(config.totalShortOi),
    );

    res.json({
      rate: rateAnnualized,
      rate8h,
      twapPrice,
      spotPrice,
      sampleCount,
      enhanced: {
        rate8h: enhanced.rate8h,
        rateAnnualized: enhanced.rateAnnualized,
        components: enhanced.components,
        model: "predictive-controller",
      },
    });
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

// ---- settle-funding (manual trigger for testing) ----
app.post("/build-tx/settle-funding", async (req, res) => {
  try {
    const { caller, positionOwner } = req.body ?? {};
    if (!caller || !positionOwner) {
      return res.status(400).json({ error: "caller, positionOwner required" });
    }
    const callerPk = new PublicKey(caller);
    const config = await loadConfig();

    // Compute current funding rate
    const { twapPrice, sampleCount } = compute8hTwap();
    if (sampleCount < 1) {
      return res.status(503).json({ error: "not_enough_samples", message: "Need at least 1 TWAP sample" });
    }
    const { price6dp } = await fetchLatestPrice();
    const spotPrice = Number(price6dp) / 1e6;
    const { rate8h } = computeFundingRate(spotPrice, twapPrice);
    const rateBps = BigInt(Math.max(-100, Math.min(100, Math.round(rate8h * 100))));

    const ix = buildSettleFundingIx({
      caller: callerPk,
      positionOwner: new PublicKey(positionOwner),
      fundingRateBps: rateBps,
      pythPriceFeed: config.pythSolFeed,
    });

    const [{ blockhash, lastValidBlockHeight }, lookupTables] = await Promise.all([
      connection.getLatestBlockhash(),
      getAlt(),
    ]);

    const msg = new TransactionMessage({
      payerKey: callerPk, recentBlockhash: blockhash, instructions: [ix],
    }).compileToV0Message(lookupTables);

    res.json({
      tx: Buffer.from(new VersionedTransaction(msg).serialize()).toString("base64"),
      blockhash,
      lastValidBlockHeight,
      fundingRateBps: rateBps.toString(),
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

app.get("/funding-crank/status", (_req, res) => {
  res.json(fundingCrankStats);
});

// ---- DFBA routing: hybrid engine status ----
app.get("/dfba/status", async (_req, res) => {
  try {
    const config = await loadConfig();
    const vpin = getVpinClassification();
    const risk = evaluateVaultRisk(config);
    res.json({
      vpin,
      spread: {
        model: risk.model,
        spreadBps: risk.spreadBps,
        bidSpreadBps: risk.bidSpreadBps,
        askSpreadBps: risk.askSpreadBps,
        reservationOffsetBps: risk.reservationOffsetBps,
        skewPct: risk.skewPct,
        suspended: risk.suspended,
      },
      routing: {
        description: "Hybrid engine: DFBA for price discovery, oracle vault as backstop",
        dfbaActive: true,
        vaultBackstopActive: true,
      },
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
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

app.get("/price/:market", async (req, res) => {
  try {
    const marketParam = req.params.market.toUpperCase();
    // Support both "sol" and "SOL-PERP" formats
    const symbol = marketParam.endsWith("-PERP") ? marketParam : `${marketParam}-PERP`;
    const marketInfo = getMarket(symbol);
    if (!marketInfo) return res.status(400).json({ error: `Unknown market: ${req.params.market}` });
    const p = await fetchLatestPrice(marketInfo.pythFeedId);
    res.json({
      price: Number(p.price6dp) / 1e6,
      confidence: Number(p.confidence6dp) / 1e6,
      publishTime: p.publishTime,
      market: symbol,
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
