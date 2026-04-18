use solana_program::pubkey::Pubkey;

// === External Program IDs (mainnet) ===

pub const KAMINO_LENDING_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

pub const JUPITER_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

pub const SPL_TOKEN_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// === Pyth Price Feed IDs (mainnet hex) ===

pub const PYTH_SOL_USD_FEED_ID: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4,
    0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc,
    0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];

// === Pyth On-Chain Feed Account Addresses (mainnet) ===
// These are the account Pubkeys passed to instructions, not the hex feed IDs.

pub const PYTH_SOL_FEED: Pubkey =
    solana_program::pubkey!("7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE");

pub const PYTH_BTC_FEED: Pubkey =
    solana_program::pubkey!("4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo");

pub const PYTH_ETH_FEED: Pubkey =
    solana_program::pubkey!("42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC");

/// Check if a Pyth price feed account is in the allowed whitelist.
#[cfg(not(feature = "mock-oracle"))]
pub fn is_allowed_feed(feed: &Pubkey) -> bool {
    *feed == PYTH_SOL_FEED || *feed == PYTH_BTC_FEED || *feed == PYTH_ETH_FEED
}

#[cfg(feature = "mock-oracle")]
pub fn is_allowed_feed(_feed: &Pubkey) -> bool {
    true
}

// === Oracle Thresholds ===

pub const MAX_ORACLE_AGE_SECONDS: u64 = 5;
pub const MAX_ORACLE_CONFIDENCE_BPS: u64 = 100; // 1%

// === Protocol Defaults ===

pub const DEFAULT_MAX_LEVERAGE: u64 = 10_000;
pub const DEFAULT_LIQUIDATION_THRESHOLD_BPS: u64 = 8_500;
pub const DEFAULT_PROTOCOL_FEE_BPS: u64 = 10;
pub const DEFAULT_MAX_TVL: u64 = 500_000_000_000;

// === PDA Seeds ===

pub const CONFIG_SEED: &[u8] = b"config";
pub const POSITION_SEED: &[u8] = b"position";
pub const AUTHORITY_SEED: &[u8] = b"authority";

// === Arithmetic ===

pub const BPS_DENOMINATOR: u64 = 10_000;
pub const PRICE_DECIMALS: u8 = 6;
pub const USDC_DECIMALS: u8 = 6;
pub const SOL_DECIMALS: u8 = 9;

// === Liquidation ===

pub const LIQUIDATION_BONUS_BPS: u64 = 500;
