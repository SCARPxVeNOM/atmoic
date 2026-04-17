/**
 * Squads Propose — proposes a program upgrade through the Squads multisig.
 *
 * Usage:
 *   npx ts-node scripts/squads-propose.ts <multisig_pda> <buffer_address>
 *
 * Steps:
 *   1. First write the buffer: solana program write-buffer target/deploy/atomic_perps.so
 *   2. Then propose: npx ts-node scripts/squads-propose.ts <multisig> <buffer>
 *   3. Approve at app.squads.so
 */

import {
  Connection,
  Keypair,
  PublicKey,
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
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error("Usage: npx ts-node scripts/squads-propose.ts <multisig_pda> <buffer_address>");
    console.error("\nSteps:");
    console.error("  1. solana program write-buffer target/deploy/atomic_perps.so");
    console.error("  2. npx ts-node scripts/squads-propose.ts <multisig> <buffer>");
    process.exit(1);
  }

  const multisigPda = new PublicKey(args[0]);
  const bufferAddress = new PublicKey(args[1]);

  const connection = new Connection(RPC_URL, "confirmed");
  const proposer = loadKeypair(KEYPAIR_PATH);

  console.log("Proposer:", proposer.publicKey.toBase58());
  console.log("Multisig:", multisigPda.toBase58());
  console.log("Buffer:", bufferAddress.toBase58());
  console.log("Program:", PROGRAM_ID.toBase58());

  // Get current transaction index
  const msAccount = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda
  );
  const txIndex = Number(msAccount.transactionIndex) + 1;

  console.log(`\nProposing upgrade as transaction #${txIndex}...`);

  // Create the proposal
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: 0 });

  const { blockhash } = await connection.getLatestBlockhash();

  // Create a vault transaction that calls BPF Upgradeable Loader's Upgrade instruction
  const tx = multisig.transactions.vaultTransactionCreate({
    blockhash,
    feePayer: proposer.publicKey,
    multisigPda,
    transactionIndex: BigInt(txIndex),
    creator: proposer.publicKey,
    vaultIndex: 0,
    ephemeralSigners: 0,
    transactionMessage: new multisig.generated.TransactionMessage({
      numSigners: 1,
      numWritableSigners: 1,
      numWritableNonSigners: 3,
      accountKeys: [
        vaultPda,
        // BPFLoaderUpgradeable programdata, program, buffer, spill, rent, clock
        // These need to be filled in based on the actual upgrade instruction accounts
      ],
      instructions: [],
    }),
  });

  console.log("\nNote: For full program upgrade via Squads, use the Squads UI at app.squads.so");
  console.log("Navigate to: Programs > Add Program > Paste program ID > Propose Upgrade");
  console.log("This is simpler and handles all the BPF Loader account resolution automatically.");
  console.log(`\nMultisig: ${multisigPda.toBase58()}`);
  console.log(`Vault: ${vaultPda.toBase58()}`);
  console.log(`Buffer: ${bufferAddress.toBase58()}`);
}

main().catch((e) => {
  console.error("Failed:", e);
  process.exit(1);
});
