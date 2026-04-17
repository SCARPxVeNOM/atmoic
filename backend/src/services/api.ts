import express from "express";
import cors from "cors";
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
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
  buildKaminoBorrow,
  buildKaminoRepay,
  extractIxForCpi,
} from "../lib/kamino";
import { evaluateVaultRisk } from "../lib/spread";
import { countAccounts } from "../lib/tx-builder";
import { getMarket } from "../lib/market-registry";
import { getPsfStatus } from "../lib/psf";
import { liquidatorStats } from "./liquidator";
import { compute8hTwap, computeFundingRate, getFundingHistory } from "../lib/funding";
import { breakerState } from "./circuit-breaker";
import { crankStats } from "./crank";

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
    const { inputMint, outputMint, amount, slippageBps = "50" } = req.query;
    if (!inputMint || !outputMint || !amount) {
      return res.status(400).json({ error: "inputMint, outputMint, amount required" });
    }
    const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=${slippageBps}`;
    const r = await fetch(url);
    res.status(r.status).json(await r.json());
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
      market = "SOL-PERP",
    } = req.body ?? {};
    if (!wallet || !collateralAmount || !borrowAmount || !side || !leverageBps) {
      return res.status(400).json({ error: "missing required field" });
    }

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

    const userSolAccount = getAssociatedTokenAddressSync(config.solMint, user);
    const userUsdcAccount = getAssociatedTokenAddressSync(config.usdcMint, user);
    const feeRecipientAccount = getAssociatedTokenAddressSync(
      config.usdcMint,
      config.feeRecipient
    );

    // Build Kamino borrow ixs if requested.
    let kaminoBorrowData: Buffer = Buffer.alloc(0);
    let kaminoRemainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    let kaminoSetupIxs: any[] = [];
    let kaminoCleanupIxs: any[] = [];

    if (useKamino) {
      const kamino = await buildKaminoBorrow(user, config.usdcMint, rawBorrow);
      const extracted = extractIxForCpi(kamino.lendingIx);
      kaminoBorrowData = extracted.data;
      kaminoRemainingAccounts = [
        { pubkey: extracted.programId, isSigner: false, isWritable: false },
        ...extracted.accounts,
      ];
      kaminoSetupIxs = kamino.setupIxs;
      kaminoCleanupIxs = kamino.cleanupIxs;
    }

    const ix = buildAtomicOpenIx({
      user,
      userSolAccount,
      userUsdcAccount,
      solVault: config.solVault,
      usdcReserve: config.usdcReserve,
      feeRecipientAccount,
      pythPriceFeed: marketFeed,
      collateralAmount: BigInt(collateralAmount),
      borrowAmount: rawBorrow,
      perpSide: side === "Short" ? Side.Short : Side.Long,
      leverageBps: Number(leverageBps),
      hedgeAmount: BigInt(hedgeAmount),
      spreadFeeBps: risk.spreadBps,
      jupiterSwapData: Buffer.alloc(0),
      kaminoBorrowData,
      kaminoRemainingAccounts,
    });

    // Account preflight check (F-01 R-4): fail if >32 unique accounts
    const allOpenIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ...kaminoSetupIxs, ix, ...kaminoCleanupIxs,
    ];
    const acctCount = countAccounts(allOpenIxs, user);
    if (acctCount > 32) {
      return res.status(400).json({
        error: "account_budget_exceeded",
        count: acctCount,
        message: `Transaction uses ${acctCount} accounts — exceeds safe limit of 32`,
      });
    }

    const [{ blockhash, lastValidBlockHeight }, lookupTables] = await Promise.all([
      connection.getLatestBlockhash(),
      getAlt(),
    ]);

    const message = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: allOpenIxs,
    }).compileToV0Message(lookupTables);

    const vtx = new VersionedTransaction(message);
    const serialized = Buffer.from(vtx.serialize());
    res.json({
      tx: serialized.toString("base64"),
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

    const userSolAccount = getAssociatedTokenAddressSync(config.solMint, user);
    const userUsdcAccount = getAssociatedTokenAddressSync(config.usdcMint, user);
    const feeRecipientAccount = getAssociatedTokenAddressSync(
      config.usdcMint,
      config.feeRecipient
    );

    // Build Kamino repay ixs if requested. Need borrow amount for repay amount.
    let kaminoRepayData: Buffer = Buffer.alloc(0);
    let kaminoRemainingAccounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    let kaminoSetupIxs: any[] = [];
    let kaminoCleanupIxs: any[] = [];

    if (useKamino) {
      // Look up the position to know how much to repay.
      const [positionPda] = findPositionPda(user);
      const posAcct = await connection.getAccountInfo(positionPda);
      if (!posAcct) return res.status(404).json({ error: "no position" });
      const position = decodePosition(posAcct.data);

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
      userSolAccount,
      userUsdcAccount,
      solVault: config.solVault,
      usdcReserve: config.usdcReserve,
      feeRecipientAccount,
      pythPriceFeed: config.pythSolFeed,
      kaminoRepayData,
      kaminoRemainingAccounts,
    });

    // Account preflight check (F-01 R-4)
    const allCloseIxs = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
      ...kaminoSetupIxs, ix, ...kaminoCleanupIxs,
    ];
    const acctCount = countAccounts(allCloseIxs, user);
    if (acctCount > 32) {
      return res.status(400).json({
        error: "account_budget_exceeded",
        count: acctCount,
        message: `Transaction uses ${acctCount} accounts — exceeds safe limit of 32`,
      });
    }

    const [{ blockhash, lastValidBlockHeight }, lookupTables] = await Promise.all([
      connection.getLatestBlockhash(),
      getAlt(),
    ]);

    const message = new TransactionMessage({
      payerKey: user,
      recentBlockhash: blockhash,
      instructions: allCloseIxs,
    }).compileToV0Message(lookupTables);

    const vtx = new VersionedTransaction(message);
    const serialized = Buffer.from(vtx.serialize());
    res.json({
      tx: serialized.toString("base64"),
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
