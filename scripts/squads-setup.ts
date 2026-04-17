/**
 * Squads Multisig Setup — creates a Squads v4 multisig vault and
 * transfers the program upgrade authority to it.
 *
 * Usage:
 *   npx ts-node scripts/squads-setup.ts
 *
 * Prerequisites:
 *   - Deploy keypair has upgrade authority over the program
 *   - At least 0.01 SOL for multisig creation + authority transfer
 *
 * After running:
 *   - Program upgrades require Squads multisig approval
 *   - Use squads-propose.ts to propose upgrades
 */

import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";
import * as fs from "fs";
import * as path from "path";

const RPC_URL =
  process.env.RPC_URL ??
  "https://mainnet.helius-rpc.com/?api-key=a48dd247-e6a1-48a8-a07b-4b41d366cddf";

const KEYPAIR_PATH =
  process.env.KEYPAIR_PATH ??
  path.resolve(__dirname, "../deploy-keypair.json");

const PROGRAM_ID = new PublicKey("8s677udBiKHkCNYzGEroenfN23k1vQjqR3JQvHjZcDWg");

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const creator = loadKeypair(KEYPAIR_PATH);

  console.log("Creator:", creator.publicKey.toBase58());
  console.log("Program:", PROGRAM_ID.toBase58());

  // Create multisig with creator as the sole member (1/1 threshold for solo dev)
  // Add more members later via Squads UI at app.squads.so
  const createKey = Keypair.generate();
  const [multisigPda] = multisig.getMultisigPda({ createKey: createKey.publicKey });

  console.log("\nCreating Squads multisig...");
  console.log("Multisig PDA:", multisigPda.toBase58());

  const tx = multisig.transactions.multisigCreateV2({
    blockhash: (await connection.getLatestBlockhash()).blockhash,
    createKey: createKey.publicKey,
    creator: creator.publicKey,
    multisigPda,
    configAuthority: null as any,
    treasury: new PublicKey("5DH2e3cJmFpyi6mk65EGFediunm4ui6BiKNUNrhWtD1b"),
    threshold: 1,
    members: [
      {
        key: creator.publicKey,
        permissions: multisig.types.Permissions.all(),
      },
    ],
    timeLock: 0,
    rentCollector: null as any,
  });

  tx.sign([creator, createKey]);
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction(sig, "confirmed");

  console.log("Multisig created:", sig);

  // Get the vault PDA (index 0)
  const [vaultPda] = multisig.getVaultPda({
    multisigPda,
    index: 0,
  });
  console.log("Vault PDA:", vaultPda.toBase58());

  console.log("\n=== Setup Complete ===");
  console.log("Multisig PDA:", multisigPda.toBase58());
  console.log("Vault PDA:", vaultPda.toBase58());
  console.log("\nTo transfer program upgrade authority, run:");
  console.log(`  solana program set-upgrade-authority ${PROGRAM_ID.toBase58()} --new-upgrade-authority ${vaultPda.toBase58()}`);
  console.log("\nSave these addresses!");
}

main().catch((e) => {
  console.error("Failed:", e);
  process.exit(1);
});
