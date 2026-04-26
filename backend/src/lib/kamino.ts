/**
 * Kamino Klend integration helpers.
 *
 * The klend-sdk v7 uses @solana/kit types (Address, Rpc, TransactionSigner,
 * Instruction) instead of legacy @solana/web3.js. We bridge between the two
 * type systems using @solana/compat and @solana/signers utilities.
 */

import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { KaminoMarket, KaminoAction, VanillaObligation, PROGRAM_ID as KLEND_PROGRAM_ID } from "@kamino-finance/klend-sdk";
import { fromLegacyPublicKey } from "@solana/compat";
import { createNoopSigner } from "@solana/signers";
import { createSolanaRpc } from "@solana/rpc";
import type { Address } from "@solana/addresses";
import type { Instruction, IAccountMeta } from "@solana/instructions";
import BN from "bn.js";
import { env } from "./env";

/** Kamino Main Market on mainnet. */
export const KAMINO_MAIN_MARKET = new PublicKey(
  "7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
);

const KAMINO_MAIN_MARKET_ADDR = fromLegacyPublicKey(KAMINO_MAIN_MARKET);

// Create a @solana/kit Rpc from the RPC URL for the klend-sdk.
const rpc = createSolanaRpc(env.rpcUrl as `https://${string}`);

let cachedMarket: KaminoMarket | null = null;

async function getMarket(): Promise<KaminoMarket> {
  if (!cachedMarket) {
    cachedMarket = (await KaminoMarket.load(rpc as any, KAMINO_MAIN_MARKET_ADDR, 400))!;
    if (!cachedMarket) throw new Error("Failed to load Kamino market");
  }
  return cachedMarket;
}

/** Invalidate cached market state. Call periodically or before price-sensitive ops. */
export function invalidateMarketCache(): void {
  cachedMarket = null;
}

export interface KaminoIxBundle {
  setupIxs: TransactionInstruction[];
  lendingIx: TransactionInstruction;
  cleanupIxs: TransactionInstruction[];
}

/** Convert a @solana/kit Instruction to a legacy TransactionInstruction. */
function toLegacyIx(ix: Instruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress as string),
    keys: (ix.accounts ?? []).map((a: IAccountMeta) => ({
      pubkey: new PublicKey(a.address as string),
      isSigner: a.role === 2 /* AccountRole.READONLY_SIGNER */ || a.role === 3 /* AccountRole.WRITABLE_SIGNER */,
      isWritable: a.role === 1 /* AccountRole.WRITABLE */ || a.role === 3 /* AccountRole.WRITABLE_SIGNER */,
    })),
    data: Buffer.from(ix.data ?? new Uint8Array()),
  });
}

/**
 * Build Kamino deposit instructions for a user.
 * Deposits collateral into a Kamino obligation so it can be borrowed against.
 */
export async function buildKaminoDeposit(
  user: PublicKey,
  mint: PublicKey,
  amount: bigint
): Promise<KaminoIxBundle> {
  const market = await getMarket();
  await market.loadReserves();

  const ownerAddr = fromLegacyPublicKey(user);
  const mintAddr = fromLegacyPublicKey(mint);
  const signer = createNoopSigner(ownerAddr);

  const action = await KaminoAction.buildDepositTxns(
    market,
    new BN(amount.toString()),
    mintAddr,
    signer,
    new VanillaObligation(KLEND_PROGRAM_ID),
    true,        // useV2Ixs
    undefined,   // scopeRefreshConfig
    0,           // extraComputeBudget
    true,        // includeAtaIxs
  );

  const setupIxs = [...action.setupIxs].map(toLegacyIx);
  const lendingIxs = [...action.lendingIxs].map(toLegacyIx);
  const cleanupIxs = [...action.cleanupIxs].map(toLegacyIx);

  if (lendingIxs.length === 0) throw new Error("Kamino SDK returned no deposit ixs");

  return { setupIxs, lendingIx: lendingIxs[0], cleanupIxs };
}

/**
 * Build Kamino borrow instructions for a user.
 *
 * @param user   Wallet pubkey (must sign the outer tx)
 * @param mint   Token mint to borrow (e.g. USDC)
 * @param amount Amount in native units (e.g. 100_000_000 for 100 USDC 6dp)
 */
export async function buildKaminoBorrow(
  user: PublicKey,
  mint: PublicKey,
  amount: bigint
): Promise<KaminoIxBundle> {
  const market = await getMarket();
  await market.loadReserves();

  const ownerAddr = fromLegacyPublicKey(user);
  const mintAddr = fromLegacyPublicKey(mint);
  // createNoopSigner gives us a TransactionSigner that satisfies the type
  // without actually signing — the real signature comes from the user's wallet.
  const signer = createNoopSigner(ownerAddr);

  const action = await KaminoAction.buildBorrowTxns(
    market,
    new BN(amount.toString()),
    mintAddr,
    signer,
    new VanillaObligation(KLEND_PROGRAM_ID),
    true,        // useV2Ixs
    undefined,   // scopeRefreshConfig
    0,           // extraComputeBudget — we set CU limit ourselves
    true,        // includeAtaIxs
    false        // requestElevationGroup
  );

  const setupIxs = [...action.setupIxs].map(toLegacyIx);
  const lendingIxs = [...action.lendingIxs].map(toLegacyIx);
  const cleanupIxs = [...action.cleanupIxs].map(toLegacyIx);

  if (lendingIxs.length === 0) throw new Error("Kamino SDK returned no lending ixs");

  return { setupIxs, lendingIx: lendingIxs[0], cleanupIxs };
}

/**
 * Build Kamino repay instructions for a user.
 */
export async function buildKaminoRepay(
  user: PublicKey,
  mint: PublicKey,
  amount: bigint
): Promise<KaminoIxBundle> {
  const market = await getMarket();
  await market.loadReserves();

  const ownerAddr = fromLegacyPublicKey(user);
  const mintAddr = fromLegacyPublicKey(mint);
  const signer = createNoopSigner(ownerAddr);

  const currentSlot = await rpc.getSlot().send();
  const action = await KaminoAction.buildRepayTxns(
    market,
    new BN(amount.toString()),
    mintAddr,
    signer,
    new VanillaObligation(KLEND_PROGRAM_ID),
    true,        // useV2Ixs
    undefined,   // scopeRefreshConfig
    currentSlot, // Slot
    undefined,   // payer
    0,           // extraComputeBudget
    true,        // includeAtaIxs
    false        // requestElevationGroup
  );

  const setupIxs = [...action.setupIxs].map(toLegacyIx);
  const lendingIxs = [...action.lendingIxs].map(toLegacyIx);
  const cleanupIxs = [...action.cleanupIxs].map(toLegacyIx);

  if (lendingIxs.length === 0) throw new Error("Kamino SDK returned no lending ixs");

  return { setupIxs, lendingIx: lendingIxs[0], cleanupIxs };
}

/**
 * Extract the accounts and data from a lending instruction so they can
 * be passed through our program's CPI.
 */
export function extractIxForCpi(ix: TransactionInstruction): {
  programId: PublicKey;
  accounts: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[];
  data: Buffer;
} {
  return {
    programId: ix.programId,
    accounts: ix.keys.map((k) => ({
      pubkey: k.pubkey,
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(ix.data),
  };
}
