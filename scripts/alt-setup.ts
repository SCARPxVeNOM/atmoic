/**
 * ALT (Address Lookup Table) Setup — creates and populates an ALT
 * with all static protocol addresses to enable versioned transactions.
 *
 * Solves F-01 (35-account limit) by allowing up to 64 accounts with ALT.
 *
 * Usage: npx ts-node scripts/alt-setup.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  AddressLookupTableProgram,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const RPC_URL =
  process.env.RPC_URL ??
  "https://mainnet.helius-rpc.com/?api-key=a48dd247-e6a1-48a8-a07b-4b41d366cddf";

const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ??
  path.resolve(__dirname, "../deploy-keypair.json");

// Protocol addresses to register in ALT
const ADDRESSES = [
  // Program
  new PublicKey("8s677udBiKHkCNYzGEroenfN23k1vQjqR3JQvHjZcDWg"), // Atomic Perps
  // External programs
  new PublicKey("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"),  // Kamino Klend
  new PublicKey("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"),  // Jupiter
  // Pyth feeds
  new PublicKey("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"),  // Pyth SOL/USD
  new PublicKey("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo"),  // Pyth BTC/USD
  new PublicKey("42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC"),  // Pyth ETH/USD
  // Protocol PDAs + vaults
  new PublicKey("GXkAYTUjswyCdj1jARAvHvwW2JPXR8q5ZQyc9Vfr7eAM"),  // Config PDA
  new PublicKey("9MfZQ4LGmBXb48Gfim8uV73jdaDkgMG5uQEoNgovE1F2"),  // Program Authority PDA
  new PublicKey("57xmaXPEm5N1fZpjPstTYk86zvYh2aCCsJkj8mvJKWbE"),  // SOL Vault
  new PublicKey("BeJCJfs5ADZ8rv1ze1mmKtEGAQdmmqLYjvFdHHcLQ3G7"),  // USDC Reserve
  // SPL
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
];

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair(KEYPAIR_PATH);
  const slot = await connection.getSlot();

  console.log("Authority:", authority.publicKey.toBase58());
  console.log("Creating ALT at slot:", slot);

  // Create ALT
  const [createIx, altAddress] = AddressLookupTableProgram.createLookupTable({
    authority: authority.publicKey,
    payer: authority.publicKey,
    recentSlot: slot,
  });

  const createTx = new Transaction().add(createIx);
  const createSig = await sendAndConfirmTransaction(connection, createTx, [authority]);
  console.log("ALT created:", altAddress.toBase58(), "sig:", createSig);

  // Extend ALT with addresses (max 30 per tx)
  for (let i = 0; i < ADDRESSES.length; i += 20) {
    const batch = ADDRESSES.slice(i, i + 20);
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: authority.publicKey,
      authority: authority.publicKey,
      lookupTable: altAddress,
      addresses: batch,
    });
    const extendTx = new Transaction().add(extendIx);
    const sig = await sendAndConfirmTransaction(connection, extendTx, [authority]);
    console.log(`Added ${batch.length} addresses, sig: ${sig}`);
  }

  console.log("\n=== ALT Setup Complete ===");
  console.log("ALT Address:", altAddress.toBase58());
  console.log("Addresses registered:", ADDRESSES.length);
  console.log("\nAdd to backend/.env:");
  console.log(`ALT_ADDRESS=${altAddress.toBase58()}`);
}

main().catch(e => { console.error("Failed:", e); process.exit(1); });
