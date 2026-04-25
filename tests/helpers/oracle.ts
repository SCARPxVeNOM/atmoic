import {
  Connection,
  Keypair,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { buildSetMockOracleIx } from "./program";

/**
 * Create a program-owned oracle account with custom price + confidence.
 * Returns the oracle keypair (keep it for later updateOraclePrice calls).
 */
export async function createMockOracleAccount(
  connection: Connection,
  payer: Keypair,
  price: bigint,
  confidence: bigint,
): Promise<Keypair> {
  const oracleKp = Keypair.generate();
  const ix = buildSetMockOracleIx(payer.publicKey, oracleKp.publicKey, price, confidence);
  const tx = new Transaction().add(ix);
  await sendAndConfirmTransaction(connection, tx, [payer, oracleKp]);
  return oracleKp;
}

/**
 * Update an existing oracle account's price + confidence.
 * The oracle keypair must be the same one returned by createMockOracleAccount.
 */
export async function updateOraclePrice(
  connection: Connection,
  payer: Keypair,
  oracleKp: Keypair,
  price: bigint,
  confidence: bigint,
): Promise<void> {
  const ix = buildSetMockOracleIx(payer.publicKey, oracleKp.publicKey, price, confidence);
  const tx = new Transaction().add(ix);
  await sendAndConfirmTransaction(connection, tx, [payer, oracleKp]);
}
