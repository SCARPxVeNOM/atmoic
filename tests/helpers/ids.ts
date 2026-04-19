import { PublicKey } from "@solana/web3.js";

// Our program
export const ATOMIC_PERPS_PROGRAM_ID = new PublicKey(
  "8s677udBiKHkCNYzGEroenfN23k1vQjqR3JQvHjZcDWg"
);

// External mainnet programs (for CPI target + validator cloning)
export const KAMINO_LENDING_PROGRAM_ID = new PublicKey(
  "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"
);
export const JUPITER_PROGRAM_ID = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
);

// Pyth SOL/USD price update V2 on mainnet
export const PYTH_SOL_USD_FEED = new PublicKey(
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE"
);
// Placeholders for BTC/USD, ETH/USD — not used by MVP but passed to initialize
export const PYTH_BTC_USD_FEED = new PublicKey(
  "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo"
);
export const PYTH_ETH_USD_FEED = new PublicKey(
  "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC"
);

// PDA seeds — must match constants.rs
export const CONFIG_SEED = Buffer.from("config");
export const POSITION_SEED = Buffer.from("position");
export const AUTHORITY_SEED = Buffer.from("authority");

// BPS constants — must match constants.rs
export const DEFAULT_MAX_LEVERAGE = 10_000; // 10x
export const DEFAULT_LIQUIDATION_THRESHOLD_BPS = 8_500;
export const DEFAULT_PROTOCOL_FEE_BPS = 10;
export const DEFAULT_MAX_TVL = 500_000_000_000n; // 500k USDC (6dp)

export const SOL_DECIMALS = 9;
export const USDC_DECIMALS = 6;
export const JLP_DECIMALS = 6;
export const MSOL_DECIMALS = 9;

// Side enum discriminant (matches Rust Side)
export enum Side {
  Long = 0,
  Short = 1,
}
