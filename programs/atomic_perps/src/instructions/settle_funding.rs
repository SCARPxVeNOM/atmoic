use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::Sysvar,
};

use crate::errors::AtomicPerpsError;
use crate::constants::*;
use crate::ensure;
use crate::utils::oracle::validate_and_get_price;
use crate::utils::math::{checked_mul_div, get_decimals_for_mint};
use crate::utils::account::{load_config, save_config, load_position, save_position};
use crate::events::emit_funding_settled;

/// Instruction data: funding_rate_bps (i64, 8 bytes)
/// Positive = longs pay shorts, negative = shorts pay longs.
/// Computed off-chain via 8h Pyth TWAP per R-2 spec.
fn parse_data(data: &[u8]) -> Option<i64> {
    if data.len() < 8 { return None; }
    Some(i64::from_le_bytes(data[0..8].try_into().unwrap()))
}

/// settle_funding — applies 8h TWAP funding rate to a single position.
///
/// Accounts:
///   0. caller (signer) — permissionless, anyone can crank
///   1. global_config (writable)
///   2. position (writable)
///   3. pyth_price_feed
///
/// Timing: must be >= FUNDING_INTERVAL_SECONDS since last settlement.
/// Rate bounds: |funding_rate_bps| <= MAX_FUNDING_RATE_BPS (1%).
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let funding_rate_bps = parse_data(data)
        .ok_or(ProgramError::InvalidInstructionData)?;

    let iter = &mut accounts.iter();
    let caller = next_account_info(iter)?;
    let global_config_ai = next_account_info(iter)?;
    let position_ai = next_account_info(iter)?;
    let pyth_price_feed = next_account_info(iter)?;

    ensure!(caller.is_signer, AtomicPerpsError::Unauthorized);

    // Verify config PDA
    let (config_pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    ensure!(*global_config_ai.key == config_pda, AtomicPerpsError::BadInput);

    let mut config = load_config(global_config_ai)?;

    // Restrict caller to authority until on-chain TWAP is implemented
    ensure!(*caller.key == config.authority, AtomicPerpsError::Unauthorized);
    let mut position = load_position(position_ai)?;

    ensure!(position.is_open, AtomicPerpsError::PositionNotOpen);
    ensure!(!config.is_paused, AtomicPerpsError::ProtocolPaused);

    // Verify position PDA
    let (expected_pos_pda, _) = Pubkey::find_program_address(
        &[POSITION_SEED, position.owner.as_ref(), pyth_price_feed.key.as_ref()],
        program_id,
    );
    ensure!(*position_ai.key == expected_pos_pda, AtomicPerpsError::BadInput);

    // Timing check: at least 8h since last settlement
    let clock = Clock::get()?;
    let elapsed = clock.unix_timestamp.saturating_sub(config.last_funding_at);
    ensure!(elapsed >= FUNDING_INTERVAL_SECONDS, AtomicPerpsError::FundingTooSoon);

    // Validate funding rate within bounds (+-1% max)
    ensure!(
        funding_rate_bps.abs() <= MAX_FUNDING_RATE_BPS,
        AtomicPerpsError::FundingRateExceedsMax
    );

    // Verify oracle matches position's market and is fresh
    ensure!(is_allowed_feed(pyth_price_feed.key), AtomicPerpsError::InvalidOracleFeed);
    ensure!(*pyth_price_feed.key == position.perp_market, AtomicPerpsError::InvalidOracleFeed);
    let (current_price, _conf) = validate_and_get_price(pyth_price_feed, &clock)?;

    // Calculate funding adjustment in USD: (perp_size * funding_rate_bps) / BPS_DENOMINATOR
    let perp_size_i = position.perp_size as i128;
    let adjustment_usd_128 = (perp_size_i * (funding_rate_bps as i128)) / (BPS_DENOMINATOR as i128);
    let adjustment_usd = i64::try_from(adjustment_usd_128)
        .map_err(|_| ProgramError::from(AtomicPerpsError::MathOverflow))?;

    // Determine direction: longs pay positive funding, shorts receive it
    let effective_adjustment_usd = match position.perp_side {
        crate::state::Side::Long => -adjustment_usd,  // Longs pay positive funding
        crate::state::Side::Short => adjustment_usd,   // Shorts receive positive funding
    };

    // Convert USD adjustment to collateral units using oracle price
    // adjustment_usd is in 6dp, collateral_amount is in native units (SOL 9dp, JLP 6dp)
    let coll_decimals = get_decimals_for_mint(&position.collateral_mint);
    let pow = 10u64.checked_pow(coll_decimals as u32)
        .ok_or(AtomicPerpsError::MathOverflow)?;

    let adjustment_abs_usd = effective_adjustment_usd.unsigned_abs();
    let adjustment_collateral = if adjustment_abs_usd == 0 {
        0u64
    } else {
        checked_mul_div(adjustment_abs_usd, pow, current_price.max(1))?
    };

    let new_collateral = if effective_adjustment_usd >= 0 {
        position.collateral_amount.saturating_add(adjustment_collateral)
    } else {
        position.collateral_amount.saturating_sub(adjustment_collateral)
    };

    emit_funding_settled(
        &position.owner,
        funding_rate_bps,
        effective_adjustment_usd,
        new_collateral,
    );

    position.collateral_amount = new_collateral;

    // Update global state
    config.last_funding_at = clock.unix_timestamp;
    config.accumulated_funding = config.accumulated_funding.saturating_add(funding_rate_bps);

    save_config(global_config_ai, &config)?;
    save_position(position_ai, &position)?;

    Ok(())
}
