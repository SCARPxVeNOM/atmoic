/**
 * Fund the USDC reserve: swap SOL→USDC via Jupiter, transfer to reserve,
 * then update on-chain config to reflect the new reserve amount.
 *
 * Usage: npx ts-node scripts/fund-reserve.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const RPC_URL =
  process.env.RPC_URL ??
  "https://mainnet.helius-rpc.com/?api-key=a48dd247-e6a1-48a8-a07b-4b41d366cddf";

const KEYPAIR_PATH = path.resolve(__dirname, "../deploy-keypair.json");
const PROGRAM_ID = new PublicKey("8s677udBiKHkCNYzGEroenfN23k1vQjqR3JQvHjZcDWg");
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_RESERVE = new PublicKey("BeJCJfs5ADZ8rv1ze1mmKtEGAQdmmqLYjvFdHHcLQ3G7");

// Swap 0.03 SOL ≈ $4-5 USDC (reserve already has ~$6)
const SWAP_LAMPORTS = 30_000_000;

const CONFIG_SEED = Buffer.from("config");

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

function writeU64LE(n: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return b;
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair(KEYPAIR_PATH);
  console.log("Authority:", authority.publicKey.toBase58());
  console.log("Balance:", (await connection.getBalance(authority.publicKey)) / 1e9, "SOL");

  // Step 1: Ensure deployer USDC ATA exists
  const deployerUsdcAta = getAssociatedTokenAddressSync(USDC_MINT, authority.publicKey);
  const ataInfo = await connection.getAccountInfo(deployerUsdcAta);
  if (!ataInfo) {
    console.log("Creating deployer USDC ATA...");
    const ataTx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        authority.publicKey, deployerUsdcAta, authority.publicKey, USDC_MINT,
      ),
    );
    const sig = await sendAndConfirmTransaction(connection, ataTx, [authority]);
    console.log("ATA created:", sig);
  } else {
    console.log("Deployer USDC ATA exists:", deployerUsdcAta.toBase58());
  }

  // Step 2: Swap SOL→USDC via Jupiter
  console.log("\nSwapping", SWAP_LAMPORTS / 1e9, "SOL → USDC...");
  const quoteUrl = `https://api.jup.ag/swap/v1/quote?inputMint=${SOL_MINT.toBase58()}&outputMint=${USDC_MINT.toBase58()}&amount=${SWAP_LAMPORTS}&slippageBps=100`;
  const quoteResp = await fetch(quoteUrl);
  if (!quoteResp.ok) throw new Error(`Jupiter quote: ${quoteResp.status} ${await quoteResp.text()}`);
  const quoteData = await quoteResp.json() as any;
  console.log("Quote:", SWAP_LAMPORTS / 1e9, "SOL →", Number(quoteData.outAmount) / 1e6, "USDC");

  const swapResp = await fetch("https://api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quoteData,
      userPublicKey: authority.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
    }),
  });
  if (!swapResp.ok) throw new Error(`Jupiter swap: ${swapResp.status} ${await swapResp.text()}`);
  const swapData = await swapResp.json() as any;

  const swapTxBuf = Buffer.from(swapData.swapTransaction, "base64");
  const vTx = VersionedTransaction.deserialize(swapTxBuf);
  vTx.sign([authority]);

  const swapSig = await connection.sendTransaction(vTx, { skipPreflight: false });
  console.log("Swap submitted:", swapSig);
  await connection.confirmTransaction(swapSig, "confirmed");
  console.log("Swap confirmed!");

  // Step 3: Check USDC balance and transfer to reserve
  const usdcBalance = await connection.getTokenAccountBalance(deployerUsdcAta);
  const usdcAmount = BigInt(usdcBalance.value.amount);
  console.log("\nDeployer USDC:", usdcBalance.value.uiAmountString, "USDC");

  if (usdcAmount === 0n) throw new Error("No USDC received from swap!");

  console.log("Transferring", usdcAmount.toString(), "USDC to reserve...");
  const transferTx = new Transaction().add(
    createTransferInstruction(
      deployerUsdcAta, USDC_RESERVE, authority.publicKey, usdcAmount,
    ),
  );
  const transferSig = await sendAndConfirmTransaction(connection, transferTx, [authority]);
  console.log("Transfer sig:", transferSig);

  // Step 4: Update on-chain config with total_usdc_reserve (existing + new)
  const reserveAfter = await connection.getTokenAccountBalance(USDC_RESERVE);
  const totalReserve = BigInt(reserveAfter.value.amount);

  const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);
  const NO_CHANGE_PK = PublicKey.default;
  const NO_CHANGE_U64 = BigInt("18446744073709551615");

  const updateData = Buffer.concat([
    discriminator("update_config"),
    NO_CHANGE_PK.toBuffer(),       // new_authority
    NO_CHANGE_PK.toBuffer(),       // new_fee_recipient
    writeU64LE(NO_CHANGE_U64),     // protocol_fee_bps
    writeU64LE(NO_CHANGE_U64),     // max_leverage
    writeU64LE(NO_CHANGE_U64),     // liquidation_threshold
    writeU64LE(NO_CHANGE_U64),     // max_tvl
    Buffer.from([255]),            // is_paused (no change)
    writeU64LE(totalReserve),      // total_usdc_reserve (actual total)
  ]);

  const updateIx = {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
    ],
    data: updateData,
  };

  const updateTx = new Transaction().add(updateIx);
  const updateSig = await sendAndConfirmTransaction(connection, updateTx, [authority]);
  console.log("Config updated:", updateSig);

  // Verify
  const reserveBalance = await connection.getTokenAccountBalance(USDC_RESERVE);
  console.log("\n=== Reserve Funded ===");
  console.log("USDC Reserve balance:", reserveBalance.value.uiAmountString, "USDC");
  console.log("Config total_usdc_reserve set to:", usdcAmount.toString());
  console.log("Remaining SOL:", (await connection.getBalance(authority.publicKey)) / 1e9, "SOL");
}

main().catch((e) => { console.error("Failed:", e); process.exit(1); });
