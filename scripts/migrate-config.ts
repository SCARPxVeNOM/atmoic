/**
 * Migrate GlobalConfig from v1 to v2 (adds OI tracking + PSF fields).
 *
 * Usage: npx ts-node scripts/migrate-config.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

const RPC_URL = process.env.RPC_URL ?? "https://mainnet.helius-rpc.com/?api-key=a48dd247-e6a1-48a8-a07b-4b41d366cddf";
const KEYPAIR_PATH = process.env.KEYPAIR_PATH ?? path.resolve(__dirname, "../deploy-keypair.json");
const PROGRAM_ID = new PublicKey("8s677udBiKHkCNYzGEroenfN23k1vQjqR3JQvHjZcDWg");
const CONFIG_SEED = Buffer.from("config");

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

function discriminator(name: string): Buffer {
  return createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const authority = loadKeypair(KEYPAIR_PATH);
  const [configPda] = PublicKey.findProgramAddressSync([CONFIG_SEED], PROGRAM_ID);

  console.log("Authority:", authority.publicKey.toBase58());
  console.log("Config PDA:", configPda.toBase58());

  const acct = await connection.getAccountInfo(configPda);
  if (!acct) { console.log("Config not found!"); return; }
  console.log("Current config size:", acct.data.length, "bytes");

  if (acct.data.length >= 8 + 299) {
    console.log("Already migrated to v2!");
    return;
  }

  const ix = {
    programId: PROGRAM_ID,
    keys: [
      { pubkey: authority.publicKey, isSigner: true, isWritable: true },
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: discriminator("migrate_config"),
  };

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: authority.publicKey, blockhash, lastValidBlockHeight }).add(ix);
  const sig = await sendAndConfirmTransaction(connection, tx, [authority]);

  console.log("Migrated! Sig:", sig);

  const newAcct = await connection.getAccountInfo(configPda);
  console.log("New config size:", newAcct?.data.length, "bytes");
}

main().catch(e => { console.error("Failed:", e); process.exit(1); });
