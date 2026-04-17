/**
 * Initialize the Atomic Perps program on mainnet.
 *
 * Multi-phase process:
 *   Phase 1: Create sol_vault + usdc_reserve token accounts
 *   Phase 2: Swap ~$10 SOL → USDC via Jupiter, transfer to reserve
 *   Phase 3: Call initialize (reads non-zero USDC balance)
 *
 * Usage:
 *   npx ts-node scripts/initialize-mainnet.ts
 *
 * Env vars (or set inline below):
 *   RPC_URL          — Helius RPC endpoint
 *   KEYPAIR_PATH     — path to the deploy/authority keypair JSON
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeAccountInstruction,
  createTransferInstruction,
  getMinimumBalanceForRentExemptAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  ACCOUNT_SIZE,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";

// ===== Config =====

const RPC_URL =
  process.env.RPC_URL ??
  "https://mainnet.helius-rpc.com/?api-key=a48dd247-e6a1-48a8-a07b-4b41d366cddf";

const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ??
  path.resolve(__dirname, "../deploy-keypair.json");

const PROGRAM_ID = new PublicKey("8s677udBiKHkCNYzGEroenfN23k1vQjqR3JQvHjZcDWg");

// Phase 0 parameters (from limitations-handbook)
const FEE_RECIPIENT = new PublicKey("B6BjBiAeTo2jCG1D6VkRLdPzKquAKvAmVJ26siHd4n85");
const PYTH_SOL_FEED = new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const MAX_LEVERAGE = 10_000n;           // 10x
const LIQUIDATION_THRESHOLD = 8_500n;   // 85% LTV
const PROTOCOL_FEE_BPS = 10n;           // 0.1%
const MAX_TVL = 500_000_000_000n;       // $500K USDC (6dp)

// Swap amount: ~$10 worth of SOL in lamports (0.07 SOL ≈ $10 at ~$145/SOL)
const SWAP_LAMPORTS = 70_000_000; // 0.07 SOL

// PDA seeds — must match constants.rs
const CONFIG_SEED = Buffer.from("config");
const AUTHORITY_SEED = Buffer.from("authority");

// Path to save vault keypairs (so we can resume if a phase fails)
const STATE_FILE = path.resolve(__dirname, "../.init-state.json");

// ===== Helpers =====

function loadKeypair(p: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(p, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function findPda(seeds: Buffer[]): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID);
}

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function writeU64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

function writePubkey(pk: PublicKey): Buffer {
  return pk.toBuffer();
}

interface InitState {
  solVaultSecret?: number[];
  usdcReserveSecret?: number[];
  phase1Done?: boolean;
  phase2Done?: boolean;
  phase3Done?: boolean;
}

function loadState(): InitState {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")); } catch { return {}; }
}
function saveState(s: InitState) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

// ===== Main =====

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair(KEYPAIR_PATH);
  console.log("Authority:", authority.publicKey.toBase58());

  const [configPda] = findPda([CONFIG_SEED]);
  const [programAuthority] = findPda([AUTHORITY_SEED]);
  console.log("Config PDA:", configPda.toBase58());
  console.log("Program Authority PDA:", programAuthority.toBase58());

  // Check if already initialized
  const existingConfig = await connection.getAccountInfo(configPda);
  if (existingConfig) {
    console.log("Program already initialized! Config account exists.");
    return;
  }

  const state = loadState();

  // ----- Phase 1: Create token accounts -----
  let solVault: Keypair;
  let usdcReserve: Keypair;

  if (state.solVaultSecret && state.usdcReserveSecret) {
    solVault = Keypair.fromSecretKey(Uint8Array.from(state.solVaultSecret));
    usdcReserve = Keypair.fromSecretKey(Uint8Array.from(state.usdcReserveSecret));
    console.log("\nResuming with saved keypairs:");
  } else {
    solVault = Keypair.generate();
    usdcReserve = Keypair.generate();
    state.solVaultSecret = Array.from(solVault.secretKey);
    state.usdcReserveSecret = Array.from(usdcReserve.secretKey);
    saveState(state);
    console.log("\nGenerated new vault keypairs (saved to .init-state.json):");
  }
  console.log("  SOL Vault:", solVault.publicKey.toBase58());
  console.log("  USDC Reserve:", usdcReserve.publicKey.toBase58());

  if (!state.phase1Done) {
    console.log("\n--- Phase 1: Creating token accounts ---");
    const rentExempt = await getMinimumBalanceForRentExemptAccount(connection);
    console.log("Token account rent:", rentExempt / 1e9, "SOL each");

    const tx1 = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: solVault.publicKey,
        lamports: rentExempt,
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(
        solVault.publicKey,
        SOL_MINT,
        programAuthority,
      ),
      SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: usdcReserve.publicKey,
        lamports: rentExempt,
        space: ACCOUNT_SIZE,
        programId: TOKEN_PROGRAM_ID,
      }),
      createInitializeAccountInstruction(
        usdcReserve.publicKey,
        USDC_MINT,
        programAuthority,
      ),
    );

    const sig1 = await sendAndConfirmTransaction(
      connection, tx1, [authority, solVault, usdcReserve],
      { commitment: "confirmed" },
    );
    console.log("Phase 1 sig:", sig1);
    state.phase1Done = true;
    saveState(state);
  } else {
    console.log("\nPhase 1 already done — token accounts exist.");
  }

  // ----- Phase 2: Swap SOL→USDC via Jupiter + transfer to reserve -----
  if (!state.phase2Done) {
    console.log("\n--- Phase 2: Swapping", SWAP_LAMPORTS / 1e9, "SOL → USDC via Jupiter ---");

    // Ensure deployer has USDC ATA
    const deployerUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, authority.publicKey);
    const ataInfo = await connection.getAccountInfo(deployerUsdcAta);
    if (!ataInfo) {
      console.log("Creating deployer USDC ATA...");
      const ataTx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          authority.publicKey,
          deployerUsdcAta,
          authority.publicKey,
          USDC_MINT,
        ),
      );
      const ataSig = await sendAndConfirmTransaction(connection, ataTx, [authority]);
      console.log("ATA created:", ataSig);
    }

    // Jupiter v6 quote
    const quoteUrl = `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT.toBase58()}&outputMint=${USDC_MINT.toBase58()}&amount=${SWAP_LAMPORTS}&slippageBps=100`;
    console.log("Fetching Jupiter quote...");
    const quoteResp = await fetch(quoteUrl);
    if (!quoteResp.ok) throw new Error(`Jupiter quote failed: ${quoteResp.status}`);
    const quoteData = await quoteResp.json() as any;
    console.log("Quote: ", SWAP_LAMPORTS / 1e9, "SOL →", Number(quoteData.outAmount) / 1e6, "USDC");

    // Jupiter swap transaction
    const swapResp = await fetch("https://quote-api.jup.ag/v6/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        quoteResponse: quoteData,
        userPublicKey: authority.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
      }),
    });
    if (!swapResp.ok) throw new Error(`Jupiter swap failed: ${swapResp.status}`);
    const swapData = await swapResp.json() as any;

    // Deserialize and sign the versioned transaction
    const swapTxBuf = Buffer.from(swapData.swapTransaction, "base64");
    const vTx = VersionedTransaction.deserialize(swapTxBuf);
    vTx.sign([authority]);

    const swapSig = await connection.sendTransaction(vTx, { skipPreflight: false });
    console.log("Swap submitted:", swapSig);
    await connection.confirmTransaction(swapSig, "confirmed");
    console.log("Swap confirmed!");

    // Check USDC balance
    const usdcBalance = await connection.getTokenAccountBalance(deployerUsdcAta);
    console.log("Deployer USDC balance:", usdcBalance.value.uiAmountString);

    // Transfer all USDC to the reserve
    const transferAmount = BigInt(usdcBalance.value.amount);
    console.log("Transferring", transferAmount.toString(), "USDC (raw) to reserve...");

    const transferTx = new Transaction().add(
      createTransferInstruction(
        deployerUsdcAta,
        usdcReserve.publicKey,
        authority.publicKey,
        transferAmount,
      ),
    );
    const transferSig = await sendAndConfirmTransaction(connection, transferTx, [authority]);
    console.log("Transfer sig:", transferSig);

    state.phase2Done = true;
    saveState(state);
  } else {
    console.log("\nPhase 2 already done — USDC in reserve.");
  }

  // Verify reserve balance
  const reserveBalance = await connection.getTokenAccountBalance(usdcReserve.publicKey);
  console.log("\nUSDC Reserve balance:", reserveBalance.value.uiAmountString, "USDC");
  if (BigInt(reserveBalance.value.amount) === 0n) {
    throw new Error("USDC Reserve is empty — cannot initialize. Fund the reserve first.");
  }

  // ----- Phase 3: Initialize -----
  if (!state.phase3Done) {
    console.log("\n--- Phase 3: Initializing protocol ---");

    const initData = Buffer.concat([
      discriminator("initialize"),
      writePubkey(FEE_RECIPIENT),
      writePubkey(PYTH_SOL_FEED),
      writePubkey(SOL_MINT),
      writePubkey(USDC_MINT),
      writeU64LE(MAX_LEVERAGE),
      writeU64LE(LIQUIDATION_THRESHOLD),
      writeU64LE(PROTOCOL_FEE_BPS),
      writeU64LE(MAX_TVL),
    ]);

    const initIx = {
      programId: PROGRAM_ID,
      keys: [
        { pubkey: authority.publicKey, isSigner: true, isWritable: true },
        { pubkey: configPda, isSigner: false, isWritable: true },
        { pubkey: programAuthority, isSigner: false, isWritable: false },
        { pubkey: solVault.publicKey, isSigner: false, isWritable: false },
        { pubkey: usdcReserve.publicKey, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data: initData,
    };

    const tx3 = new Transaction().add(initIx);
    const sig3 = await sendAndConfirmTransaction(
      connection, tx3, [authority],
      { commitment: "confirmed" },
    );
    console.log("Initialize sig:", sig3);
    state.phase3Done = true;
    saveState(state);
  }

  console.log("\n=== Protocol Initialized Successfully! ===");
  console.log("SOL Vault:", solVault.publicKey.toBase58());
  console.log("USDC Reserve:", usdcReserve.publicKey.toBase58());
  console.log("Config PDA:", configPda.toBase58());
  console.log("Program Authority:", programAuthority.toBase58());
  console.log("USDC Reserve Balance:", (await connection.getTokenAccountBalance(usdcReserve.publicKey)).value.uiAmountString, "USDC");
  console.log("\nParameters:");
  console.log("  Max Leverage:", MAX_LEVERAGE.toString(), "(10x)");
  console.log("  Liquidation Threshold:", LIQUIDATION_THRESHOLD.toString(), "(85% LTV)");
  console.log("  Protocol Fee:", PROTOCOL_FEE_BPS.toString(), "bps (0.1%)");
  console.log("  Max TVL:", MAX_TVL.toString(), "($500K USDC)");
}

main().catch((e) => {
  console.error("Failed:", e);
  process.exit(1);
});
