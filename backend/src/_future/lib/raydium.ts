/**
 * Raydium LP Integration — full-range AMM LP tokens as collateral.
 *
 * Per limitations-handbook H-02:
 * - Only accept full-range v2/AMM positions (reject CLMM)
 * - 35% haircut (worst-case IL at 50% price drop + buffer)
 * - Treat as correlated collateral during stress
 */

import { PublicKey } from "@solana/web3.js";
import { connection } from "./connection";

// Raydium AMM v4 program on mainnet
const RAYDIUM_AMM_V4 = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");

// AMM pool layout offsets (simplified):
// coin_vault_balance: u64 at offset 128
// pc_vault_balance: u64 at offset 136
// lp_supply: u64 at offset 272
const COIN_VAULT_OFFSET = 128;
const PC_VAULT_OFFSET = 136;
const LP_SUPPLY_OFFSET = 272;

export interface RaydiumLpPrice {
  /** Value per LP token in USD (6dp). */
  pricePerLp6dp: bigint;
  /** Pool's coin (base) reserve. */
  coinReserve: bigint;
  /** Pool's pc (quote) reserve. */
  pcReserve: bigint;
  /** Total LP supply. */
  lpSupply: bigint;
}

/**
 * Fetch Raydium AMM pool state and compute LP token price.
 *
 * @param poolAddress Raydium AMM pool address
 * @param coinPrice6dp Price of the coin (base) token in USD 6dp
 * @param pcPrice6dp Price of the pc (quote) token in USD 6dp (usually USDC = 1e6)
 */
export async function fetchRaydiumLpPrice(
  poolAddress: PublicKey,
  coinPrice6dp: bigint,
  pcPrice6dp: bigint = 1_000_000n, // USDC default
): Promise<RaydiumLpPrice> {
  const acct = await connection.getAccountInfo(poolAddress);
  if (!acct || acct.data.length < 300) {
    throw new Error("Raydium pool account not found or too small");
  }

  // Verify it's owned by Raydium AMM v4 (not CLMM)
  if (!acct.owner.equals(RAYDIUM_AMM_V4)) {
    throw new Error("Not a Raydium AMM v4 pool — CLMM positions are not accepted");
  }

  const buf = acct.data;
  const coinReserve = buf.readBigUInt64LE(COIN_VAULT_OFFSET);
  const pcReserve = buf.readBigUInt64LE(PC_VAULT_OFFSET);
  const lpSupply = buf.readBigUInt64LE(LP_SUPPLY_OFFSET);

  if (lpSupply === 0n) throw new Error("LP supply is zero");

  // Total pool value = coin_reserve * coin_price + pc_reserve * pc_price
  const coinValue = (coinReserve * coinPrice6dp) / 1_000_000n;
  const pcValue = (pcReserve * pcPrice6dp) / 1_000_000n;
  const totalValue = coinValue + pcValue;

  // Price per LP = total_value / lp_supply
  const pricePerLp6dp = (totalValue * 1_000_000n) / lpSupply;

  return { pricePerLp6dp, coinReserve, pcReserve, lpSupply };
}

/**
 * Compute Raydium LP collateral value with 35% haircut.
 */
export function raydiumCollateralValue(amount: bigint, pricePerLp6dp: bigint): bigint {
  const rawValue = (amount * pricePerLp6dp) / 1_000_000n;
  return (rawValue * 6_500n) / 10_000n; // 35% haircut = keep 65%
}
