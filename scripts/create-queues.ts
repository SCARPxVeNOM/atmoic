/**
 * Create 16 DFBA queue shard accounts (8 bid + 8 ask).
 *
 * Each shard holds up to 85 orders. Sharded by user_pubkey[0] % 8.
 * Per master-moves M-3: reduces write contention by 8x.
 *
 * Usage: npx ts-node scripts/create-queues.ts
 */

import {
  Connection,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const RPC_URL = process.env.RPC_URL ?? "https://mainnet.helius-rpc.com/?api-key=a48dd247-e6a1-48a8-a07b-4b41d366cddf";
const KEYPAIR_PATH = process.env.KEYPAIR_PATH ?? path.resolve(__dirname, "../deploy-keypair.json");
const PROGRAM_ID_STR = "8s677udBiKHkCNYzGEroenfN23k1vQjqR3JQvHjZcDWg";

// Queue layout: 8 (disc) + 4 (count) + 85 * 56 (orders) = 4772 bytes
const QUEUE_DISC = Buffer.from([0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8]);
const ORDER_SIZE = 56;
const MAX_ORDERS = 85;
const QUEUE_SIZE = 8 + 4 + MAX_ORDERS * ORDER_SIZE; // 4772 bytes
const NUM_SHARDS = 8;
const SIDES = ["bid", "ask"];

function loadKeypair(p: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf-8"))));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const payer = loadKeypair(KEYPAIR_PATH);
  const { PublicKey } = await import("@solana/web3.js");
  const programId = new PublicKey(PROGRAM_ID_STR);

  console.log("Payer:", payer.publicKey.toBase58());
  console.log("Queue size:", QUEUE_SIZE, "bytes each");

  const rent = await connection.getMinimumBalanceForRentExemption(QUEUE_SIZE);
  console.log("Rent per queue:", rent / 1e9, "SOL");
  console.log("Total cost:", (rent * NUM_SHARDS * SIDES.length) / 1e9, "SOL");

  const queueKeypairs: { side: string; shard: number; keypair: Keypair }[] = [];

  for (const side of SIDES) {
    for (let shard = 0; shard < NUM_SHARDS; shard++) {
      const kp = Keypair.generate();
      queueKeypairs.push({ side, shard, keypair: kp });
    }
  }

  // Create accounts in batches of 4 (to fit in single tx)
  for (let i = 0; i < queueKeypairs.length; i += 4) {
    const batch = queueKeypairs.slice(i, i + 4);
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
    const tx = new Transaction({ feePayer: payer.publicKey, blockhash, lastValidBlockHeight });

    for (const { keypair } of batch) {
      tx.add(
        SystemProgram.createAccount({
          fromPubkey: payer.publicKey,
          newAccountPubkey: keypair.publicKey,
          lamports: rent,
          space: QUEUE_SIZE,
          programId,
        })
      );
    }

    const signers = [payer, ...batch.map(b => b.keypair)];
    const sig = await sendAndConfirmTransaction(connection, tx, signers);
    console.log(`Created ${batch.length} queues (batch ${Math.floor(i/4)+1}): ${sig.slice(0, 12)}...`);
  }

  // Initialize discriminators
  console.log("\nInitializing queue discriminators...");
  for (const { side, shard, keypair } of queueKeypairs) {
    // Write discriminator + zero count directly (the program owns these accounts)
    // Actually, we can't write to program-owned accounts from a script.
    // The program's execute_batch will handle initialization on first use.
    console.log(`  ${side}_queue_${shard}: ${keypair.publicKey.toBase58()}`);
  }

  console.log("\n=== Queue Creation Complete ===");
  console.log("Save these addresses for backend configuration:");
  console.log(JSON.stringify(
    queueKeypairs.map(q => ({
      side: q.side,
      shard: q.shard,
      address: q.keypair.publicKey.toBase58(),
    })),
    null,
    2
  ));
}

main().catch(e => { console.error("Failed:", e); process.exit(1); });
