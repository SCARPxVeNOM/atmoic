/**
 * Protocol Safety Fund (PSF) Tracker.
 *
 * Per limitations-handbook: PSF = 5% of vault TVL, funded by 10% of
 * protocol fees. In Phase 1, PSF is tracked off-chain as a portion
 * of the fee_recipient balance. On-chain PSF vault is deferred to
 * the Sprint 4 program upgrade.
 */

import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { connection } from "./connection";
import { GlobalConfigData } from "./decode";

const PSF_FEE_ALLOCATION_PCT = 10; // 10% of fees go to PSF
const PSF_TARGET_PCT = 5; // PSF should be 5% of TVL

export interface PsfStatus {
  /** Total USDC held by fee_recipient (includes both operational + PSF). */
  feeRecipientBalance: string;
  /** Estimated PSF balance (10% of cumulative fees). */
  estimatedPsfBalance: string;
  /** TVL in USDC. */
  tvl: string;
  /** Target PSF balance (5% of TVL). */
  psfTarget: string;
  /** Whether PSF meets the 5% target. */
  adequate: boolean;
  /** PSF as percentage of TVL. */
  psfPctOfTvl: number;
}

export async function getPsfStatus(config: GlobalConfigData): Promise<PsfStatus> {
  // Read the fee recipient's USDC balance
  const feeAta = getAssociatedTokenAddressSync(config.usdcMint, config.feeRecipient);
  const feeAcct = await connection.getAccountInfo(feeAta);

  let feeBalance = 0n;
  if (feeAcct && feeAcct.data.length >= 72) {
    feeBalance = feeAcct.data.readBigUInt64LE(64);
  }

  // TVL = total USDC in the reserve
  const tvl = config.totalUsdcReserve;

  // PSF estimate = 10% of all fees ever collected.
  // Since we track totalUsdcBorrowed and know fee is protocolFeeBps,
  // cumulative fees ≈ totalUsdcBorrowed * feeBps / 10000 (rough)
  // PSF allocation = 10% of that
  const estCumulativeFees = (config.totalUsdcBorrowed * config.protocolFeeBps) / 10_000n;
  const estPsf = (estCumulativeFees * BigInt(PSF_FEE_ALLOCATION_PCT)) / 100n;

  const psfTarget = (tvl * BigInt(PSF_TARGET_PCT)) / 100n;
  const adequate = estPsf >= psfTarget || tvl === 0n;

  const psfPctOfTvl = tvl > 0n ? Number((estPsf * 10_000n) / tvl) / 100 : 0;

  return {
    feeRecipientBalance: feeBalance.toString(),
    estimatedPsfBalance: estPsf.toString(),
    tvl: tvl.toString(),
    psfTarget: psfTarget.toString(),
    adequate,
    psfPctOfTvl,
  };
}
