import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  createAccount,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { findAuthorityPda } from "./program";

// Load the default local validator keypair (pre-funded with 500M SOL) and fund
// test actors from it via system transfer. requestAirdrop is flaky under
// back-to-back calls on Windows test-validator; a direct transfer is reliable.
function loadLocalFaucet(): Keypair {
  const path = require("path");
  const fs = require("fs");
  // Use the deploy keypair (configured in solana CLI) as the local faucet.
  // The test-validator funds this keypair with 500M SOL.
  const file = path.resolve(__dirname, "../../deploy-keypair.json");
  const secret = JSON.parse(fs.readFileSync(file, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

const LOCAL_FAUCET = loadLocalFaucet();

export async function airdrop(
  connection: Connection,
  to: PublicKey,
  sol: number
): Promise<void> {
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: LOCAL_FAUCET.publicKey,
      toPubkey: to,
      lamports: sol * LAMPORTS_PER_SOL,
    })
  );
  await sendAndConfirmTransaction(connection, tx, [LOCAL_FAUCET]);
}

/**
 * Create a fresh mint for testing (mimics SOL or USDC).
 * Returns the mint pubkey. Mint authority is the provided keypair.
 */
export async function createTestMint(
  connection: Connection,
  payer: Keypair,
  decimals: number
): Promise<PublicKey> {
  return createMint(connection, payer, payer.publicKey, null, decimals);
}

/**
 * Create an SPL token account owned by the program_authority PDA.
 * This is what initialize expects for sol_vault and usdc_reserve.
 */
export async function createPdaOwnedTokenAccount(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey
): Promise<PublicKey> {
  const [authority] = findAuthorityPda();
  // Create an arbitrary-keyed token account (not an ATA, since the authority is a PDA
  // and we want a stable address we can reference).
  return createAccount(connection, payer, mint, authority, Keypair.generate());
}

/** Create an ATA for a user + mint and return its pubkey (idempotent). */
export async function getOrCreateAta(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const ata = await getOrCreateAssociatedTokenAccount(connection, payer, mint, owner);
  return ata.address;
}

/** Mint `amount` raw units of `mint` into `dest`. */
export async function mintToken(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  dest: PublicKey,
  mintAuthority: Keypair,
  amount: bigint | number
): Promise<void> {
  await mintTo(connection, payer, mint, dest, mintAuthority, amount);
}

export { TOKEN_PROGRAM_ID };
