/**
 * JLP (Jupiter Liquidity Provider) virtual price fetcher.
 *
 * Per limitations-handbook A-04: always fetch live JLP virtual price
 * from Jupiter pool state. Never use stored prices for health calculation.
 * JLP collateral gets 25% haircut.
 */

import { PublicKey } from "@solana/web3.js";
import { connection } from "./connection";

// Jupiter JLP Pool on mainnet
const JLP_POOL = new PublicKey("5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq");

// JLP Pool layout offsets (simplified):
// pool_value: u128 at offset 200 (total pool value in USD 6dp)
// lp_supply: u64 at offset 232 (total LP tokens)
const POOL_VALUE_OFFSET = 200;
const LP_SUPPLY_OFFSET = 232;

export interface JlpPrice {
  /** Virtual price per JLP token in USD (6dp). */
  virtualPrice6dp: bigint;
  /** Pool total value in USD (6dp). */
  poolValueUsd: bigint;
  /** Total LP supply. */
  lpSupply: bigint;
}

/**
 * Fetch the live JLP virtual price from the on-chain Jupiter pool.
 * Virtual price = pool_value / lp_supply
 */
export async function fetchJlpPrice(): Promise<JlpPrice> {
  const acct = await connection.getAccountInfo(JLP_POOL);
  if (!acct || acct.data.length < 240) {
    throw new Error("JLP pool account not found or too small");
  }

  const buf = acct.data;

  // Read u128 pool value (as two u64s — low + high)
  const poolValueLow = buf.readBigUInt64LE(POOL_VALUE_OFFSET);
  const poolValueHigh = buf.readBigUInt64LE(POOL_VALUE_OFFSET + 8);
  const poolValueUsd = poolValueLow + (poolValueHigh << 64n);

  const lpSupply = buf.readBigUInt64LE(LP_SUPPLY_OFFSET);
  if (lpSupply === 0n) throw new Error("JLP LP supply is zero");

  // Virtual price = pool_value / lp_supply (normalize to 6dp)
  const virtualPrice6dp = (poolValueUsd * 1_000_000n) / lpSupply;

  return { virtualPrice6dp, poolValueUsd, lpSupply };
}

/**
 * Compute JLP collateral value with 25% haircut.
 * Per limitations-handbook: JLP haircut = 25% (max IL + correlation losses)
 */
export function jlpCollateralValue(amount: bigint, virtualPrice6dp: bigint): bigint {
  const rawValue = (amount * virtualPrice6dp) / 1_000_000n;
  // Apply 25% haircut (keep 75%)
  return (rawValue * 7_500n) / 10_000n;
}
