/**
 * mSOL Integration — Marinade staked SOL price + depeg monitoring.
 *
 * Per limitations-handbook F-02:
 * - Monitor mSOL/SOL peg ratio continuously
 * - During stress (circuit breaker), halt new mSOL deposits
 * - 18% haircut (SOL's 10% + 8% depeg risk buffer)
 */

import { PublicKey } from "@solana/web3.js";
import { connection } from "./connection";

// Marinade State account on mainnet
const MARINADE_STATE = new PublicKey("8szGkuLTAux9XMgZ2vtY39jVSowEcpBfFfD8hXSEqdGC");

// Layout offsets for Marinade state (simplified):
// total_virtual_staked_lamports: u64 at offset 258
// msol_supply: u64 at offset 266
const STAKED_OFFSET = 258;
const SUPPLY_OFFSET = 266;

// Depeg threshold: if mSOL trades at >2% discount to fair value
const DEPEG_THRESHOLD_BPS = 200;

export interface MsolPrice {
  /** mSOL price in SOL (6dp). Fair value from stake ratio. */
  priceInSol6dp: bigint;
  /** mSOL price in USD (6dp). Requires SOL price. */
  priceInUsd6dp: bigint;
  /** Stake ratio: total_staked / msol_supply. */
  stakeRatio: number;
}

/**
 * Fetch mSOL fair value from Marinade on-chain state.
 * Fair price = total_virtual_staked_lamports / msol_supply
 */
export async function fetchMsolPrice(solPrice6dp: bigint): Promise<MsolPrice> {
  const acct = await connection.getAccountInfo(MARINADE_STATE);
  if (!acct || acct.data.length < 280) {
    throw new Error("Marinade state account not found");
  }

  const totalStaked = acct.data.readBigUInt64LE(STAKED_OFFSET);
  const msolSupply = acct.data.readBigUInt64LE(SUPPLY_OFFSET);

  if (msolSupply === 0n) throw new Error("mSOL supply is zero");

  // Stake ratio in 6dp: (totalStaked * 1e6) / msolSupply
  const priceInSol6dp = (totalStaked * 1_000_000n) / msolSupply;
  const stakeRatio = Number(priceInSol6dp) / 1e6;

  // USD price = mSOL-in-SOL * SOL-in-USD
  const priceInUsd6dp = (priceInSol6dp * solPrice6dp) / 1_000_000n;

  return { priceInSol6dp, priceInUsd6dp, stakeRatio };
}

/**
 * Check if mSOL is at depeg risk.
 * Compares on-chain fair value to a market price (if available).
 * Returns true if discount exceeds threshold.
 */
export function checkDepegRisk(
  fairPriceSol6dp: bigint,
  marketPriceSol6dp: bigint,
): { depegged: boolean; discountBps: number } {
  if (fairPriceSol6dp === 0n) return { depegged: false, discountBps: 0 };

  const diff = fairPriceSol6dp > marketPriceSol6dp
    ? fairPriceSol6dp - marketPriceSol6dp
    : 0n;
  const discountBps = Number((diff * 10_000n) / fairPriceSol6dp);

  return {
    depegged: discountBps > DEPEG_THRESHOLD_BPS,
    discountBps,
  };
}
