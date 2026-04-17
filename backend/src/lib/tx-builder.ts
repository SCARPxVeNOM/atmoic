/**
 * Versioned Transaction Builder with ALT support.
 *
 * Constructs V0 transactions using Address Lookup Tables to support
 * up to 64 accounts per transaction (solves F-01 from limitations-handbook).
 * Falls back to legacy transactions if ALT is not configured.
 */

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  Transaction,
} from "@solana/web3.js";
import { connection } from "./connection";
import { env } from "./env";

const DEFAULT_CU_LIMIT = 800_000;
const DEFAULT_CU_PRICE = 50_000;
const MAX_ACCOUNTS_LEGACY = 32;
const MAX_ACCOUNTS_ALT = 64;

let cachedAlt: AddressLookupTableAccount | null = null;

async function getAlt(): Promise<AddressLookupTableAccount | null> {
  if (!env.altAddress) return null;
  if (cachedAlt) return cachedAlt;

  const altPubkey = new PublicKey(env.altAddress);
  const result = await connection.getAddressLookupTable(altPubkey);
  if (result.value) cachedAlt = result.value;
  return cachedAlt;
}

/**
 * Count unique accounts across all instructions.
 */
function countAccounts(ixs: TransactionInstruction[], feePayer: PublicKey): number {
  const keys = new Set<string>();
  keys.add(feePayer.toBase58());
  for (const ix of ixs) {
    keys.add(ix.programId.toBase58());
    for (const k of ix.keys) keys.add(k.pubkey.toBase58());
  }
  return keys.size;
}

export interface BuiltTx {
  /** Base64 serialized transaction (versioned or legacy). */
  serialized: string;
  blockhash: string;
  lastValidBlockHeight: number;
  /** Whether this is a versioned (V0) transaction. */
  versioned: boolean;
  /** Total unique accounts in the transaction. */
  accountCount: number;
}

/**
 * Build a transaction with CU budget, optional ALT, and account preflight check.
 *
 * @param instructions  The instructions to include
 * @param feePayer      The wallet that pays fees and signs
 * @param cuLimit       Compute unit limit (default 800K)
 * @param cuPrice       Compute unit price in microLamports (default 50K)
 */
export async function buildTx(
  instructions: TransactionInstruction[],
  feePayer: PublicKey,
  cuLimit: number = DEFAULT_CU_LIMIT,
  cuPrice: number = DEFAULT_CU_PRICE,
): Promise<BuiltTx> {
  const allIxs = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cuPrice }),
    ...instructions,
  ];

  const accountCount = countAccounts(allIxs, feePayer);
  const alt = await getAlt();

  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();

  // Use versioned tx with ALT if available and account count is high
  if (alt && accountCount > MAX_ACCOUNTS_LEGACY) {
    if (accountCount > MAX_ACCOUNTS_ALT) {
      throw new Error(`Transaction has ${accountCount} accounts — exceeds max of ${MAX_ACCOUNTS_ALT} even with ALT`);
    }

    const msg = new TransactionMessage({
      payerKey: feePayer,
      recentBlockhash: blockhash,
      instructions: allIxs,
    }).compileToV0Message([alt]);

    const vtx = new VersionedTransaction(msg);
    return {
      serialized: Buffer.from(vtx.serialize()).toString("base64"),
      blockhash,
      lastValidBlockHeight,
      versioned: true,
      accountCount,
    };
  }

  // Legacy transaction
  if (accountCount > MAX_ACCOUNTS_LEGACY) {
    throw new Error(`Transaction has ${accountCount} accounts — exceeds max of ${MAX_ACCOUNTS_LEGACY}. Configure ALT_ADDRESS to enable versioned transactions.`);
  }

  const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight });
  tx.add(...allIxs);
  const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });

  return {
    serialized: serialized.toString("base64"),
    blockhash,
    lastValidBlockHeight,
    versioned: false,
    accountCount,
  };
}
