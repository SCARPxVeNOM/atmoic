use solana_program::pubkey::Pubkey;

// === External Program IDs (mainnet) ===

pub const KAMINO_LENDING_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD");

pub const JUPITER_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4");

pub const SPL_TOKEN_PROGRAM_ID: Pubkey =
    solana_program::pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

// Pyth Receiver (pull oracle) — the owner of price feed accounts on mainnet.
// Previously used the push oracle ("pythWSnswV...") which is the legacy program.
// The actual feed accounts (7UVimff..., 4cSM2e6..., 42amVS4...) are owned by the Receiver.
pub const PYTH_PUSH_ORACLE_PROGRAM: Pubkey =
    solana_program::pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

// === Pyth Price Feed IDs (mainnet hex) ===

pub const PYTH_SOL_USD_FEED_ID: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4,
    0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc,
    0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];

pub const PYTH_BTC_USD_FEED_ID: [u8; 32] = [
    0xe6, 0x2d, 0xf6, 0xc8, 0xb4, 0xa8, 0x5f, 0xe1,
    0xa6, 0x7d, 0xb4, 0x4d, 0xc1, 0x2d, 0xe5, 0xdb,
    0x33, 0x0f, 0x7a, 0xc6, 0x6b, 0x72, 0xdc, 0x65,
    0x8a, 0xfe, 0xdf, 0x0f, 0x4a, 0x41, 0x5b, 0x43,
];

pub const PYTH_ETH_USD_FEED_ID: [u8; 32] = [
    0xff, 0x61, 0x49, 0x1a, 0x93, 0x11, 0x12, 0xdd,
    0xf1, 0xbd, 0x81, 0x47, 0xcd, 0x1b, 0x64, 0x13,
    0x75, 0xf7, 0x9f, 0x58, 0x25, 0x12, 0x6d, 0x66,
    0x54, 0x80, 0x87, 0x46, 0x34, 0xfd, 0x0a, 0xce,
];

/// Look up the expected Pyth feed ID for a given on-chain feed account address.
/// Returns None if the feed is not in the whitelist.
pub fn get_feed_id_for_account(feed: &Pubkey) -> Option<&'static [u8; 32]> {
    if *feed == PYTH_SOL_FEED { Some(&PYTH_SOL_USD_FEED_ID) }
    else if *feed == PYTH_BTC_FEED { Some(&PYTH_BTC_USD_FEED_ID) }
    else if *feed == PYTH_ETH_FEED { Some(&PYTH_ETH_USD_FEED_ID) }
    else { None }
}

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

pub const MAX_ORACLE_AGE_SECONDS: u64 = 60;
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

// === DFBA (Discrete Frequent Batch Auction) ===

pub const PYTH_CAP_BPS: u64 = 30;

// === Multi-Collateral Mints (mainnet) ===

pub const MSOL_MINT: Pubkey =
    solana_program::pubkey!("mSoLzYCxHdYgdzU16g5QSh3i5K3z3KZK7ytfqcJm7So");

pub const JLP_MINT: Pubkey =
    solana_program::pubkey!("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4");

pub const MSOL_DECIMALS: u8 = 9;
pub const JLP_DECIMALS: u8 = 6;

// === Haircuts (BPS) — applied to collateral value for health calculation ===

pub const HAIRCUT_SOL_BPS: u64 = 0;        // 0% — SOL is the reference asset, no haircut needed
pub const HAIRCUT_MSOL_BPS: u64 = 1_800;  // 18%  (SOL 10% + 8% depeg risk)
pub const HAIRCUT_JLP_BPS: u64 = 2_500;   // 25%

// === Correlated Collateral Cap ===

pub const CORRELATED_CAP_BPS: u64 = 10_000; // 100% — permissive for bootstrap; tighten to 3000 in production

// === JLP Risk Parameters ===

pub const JLP_LIQUIDATION_GRACE_SECONDS: i64 = 7_200; // 2 hours
// Tightened from 5x to 2x: JLP ~$3-5 with SOL ~$150, so [SOL/2, SOL*2] = [$75, $300]
// Previous 5x bounds allowed inflating collateral value by up to 5x
pub const JLP_PRICE_SANITY_FACTOR: u64 = 2;
// mSOL trades at ~1.05-1.15x SOL — tightened sanity window
pub const MSOL_PRICE_SANITY_FACTOR: u64 = 2;

// === Risk Parameters (must match qedspec constants) ===

pub const OI_CAP_PCT: u64 = 80;
pub const MIN_SPREAD_BPS: u16 = 5;

// === Funding Rate Settlement (R-2) ===

pub const FUNDING_INTERVAL_SECONDS: i64 = 28_800; // 8 hours
// Tightened from ±1% to ±0.5% — limits authority's per-interval discretion.
// Phase 0: rate set by authority off-chain (Pyth TWAP computed in backend).
// Phase 1: on-chain TWAP replaces authority-supplied rate entirely.
pub const MAX_FUNDING_RATE_BPS: i64 = 50;          // ±0.5% max per 8h period

// === PSF (Protocol Stability Fund, R-3) ===

pub const PSF_MIN_RATIO_BPS: u64 = 500;    // 5% of vault TVL
pub const PSF_FEE_SHARE_BPS: u64 = 1_000;  // 10% of protocol fees -> PSF

// === Switchboard Fallback Oracle ===

pub const SWITCHBOARD_SOL_USD_FEED: Pubkey =
    solana_program::pubkey!("GvDMxPzN1sCj7L26YDK2HnMRXEQmQ2aemov8YBtPS7vR");

pub const ORACLE_DIVERGENCE_BPS: u64 = 200; // 2% — halt if Pyth/Switchboard diverge

// === Perps Margin ===

/// Maintenance margin: liquidation when effective_margin / notional < 5%.
/// At 10x leverage, ~4.5% adverse move triggers liquidation.
/// At 5x leverage, ~12.5% adverse move triggers liquidation.
pub const MAINTENANCE_MARGIN_BPS: u64 = 500;

// === Power Perpetuals ===

/// Standard perp: p=1.0 → linear PnL
pub const DEFAULT_POWER_MILLI: u64 = 1_000;
/// Squeeth perp: p=2.0 → quadratic PnL (options-like convexity)
pub const POWER_SQUEETH: u64 = 2_000;
/// Sqrt perp: p=0.5 → dampened exposure (stretch goal)
pub const POWER_SQRT: u64 = 500;

// === Gradual Deleveraging ===
// Instead of binary liquidation, partially close positions based on margin severity.

/// Zone 1: margin 4-5% → close 25% of position
pub const DELEVERAGE_ZONE_1_BPS: u64 = 400;
/// Zone 2: margin 3-4% → close 50% of position
pub const DELEVERAGE_ZONE_2_BPS: u64 = 300;
/// Zone 3: margin 2-3% → close 75% of position
pub const DELEVERAGE_ZONE_3_BPS: u64 = 200;
// Below 200 bps (<2%): full liquidation (100%)
