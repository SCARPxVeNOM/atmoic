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
    let mut position = load_position(position_ai)?;

    ensure!(position.is_open, AtomicPerpsError::PositionNotOpen);
    ensure!(!config.is_paused, AtomicPerpsError::ProtocolPaused);

    // Verify position PDA
    let (expected_pos_pda, _) = Pubkey::find_program_address(
        &[POSITION_SEED, position.owner.as_ref()],
        program_id,
    );
    ensure!(*position_ai.key == expected_pos_pda, AtomicPerpsError::BadInput);

    // Timing check: at least 8h since last settlement
    let clock = Clock::get()?;
    let elapsed = clock.unix_timestamp.saturating_sub(config.last_funding_at);
    ensure!(elapsed >= FUNDING_INTERVAL_SECONDS, AtomicPerpsError::FundingTooSoon);

    // Validate funding rate within bounds (±1% max)
    ensure!(
        funding_rate_bps.abs() <= MAX_FUNDING_RATE_BPS,
        AtomicPerpsError::FundingRateExceedsMax
    );

    // Verify oracle is fresh (validates staleness, confidence)
    ensure!(is_allowed_feed(pyth_price_feed.key), AtomicPerpsError::InvalidOracleFeed);
    let (_price, _conf) = validate_and_get_price(pyth_price_feed, &clock)?;

    // Calculate adjustment: (perp_size * funding_rate_bps) / BPS_DENOMINATOR
    // Longs pay when rate > 0, shorts pay when rate > 0
    let perp_size_i = position.perp_size as i128;
    let adjustment_128 = (perp_size_i * (funding_rate_bps as i128)) / (BPS_DENOMINATOR as i128);
    let adjustment = adjustment_128 as i64;

    // Apply funding: adjust collateral
    // If position is long and rate > 0: long pays (collateral decreases)
    // If position is long and rate < 0: long receives (collateral increases)
    // If position is short and rate > 0: short receives (collateral increases)
    // If position is short and rate < 0: short pays (collateral decreases)
    let effective_adjustment = match position.perp_side {
        crate::state::Side::Long => -adjustment,  // Longs pay positive funding
        crate::state::Side::Short => adjustment,   // Shorts receive positive funding
    };

    let new_collateral = if effective_adjustment >= 0 {
        position.collateral_amount.saturating_add(effective_adjustment as u64)
    } else {
        position.collateral_amount.saturating_sub((-effective_adjustment) as u64)
    };

    emit_funding_settled(
        &position.owner,
        funding_rate_bps,
        effective_adjustment,
        new_collateral,
    );

    position.collateral_amount = new_collateral;

    // Update global state
    config.last_funding_at = clock.unix_timestamp;
    config.accumulated_funding = config.accumulated_funding.wrapping_add(funding_rate_bps);

    save_config(global_config_ai, &config)?;
    save_position(position_ai, &position)?;

    Ok(())
}
