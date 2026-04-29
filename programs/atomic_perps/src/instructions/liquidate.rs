use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::Sysvar,
};

pub struct LiquidateParams {
    // V3: collateral price for JLP/mSOL (0 = use oracle)
    pub collateral_price_6dp: u64,
}

impl LiquidateParams {
    fn deserialize(data: &[u8]) -> Option<Self> {
        let collateral_price_6dp = if data.len() >= 8 {
            u64::from_le_bytes(data[0..8].try_into().unwrap())
        } else {
            0
        };
        Some(Self { collateral_price_6dp })
    }
}

use crate::errors::AtomicPerpsError;
use crate::constants::*;
use crate::ensure;
use crate::utils::oracle::{validate_and_get_price, validate_jlp_price};
use crate::utils::math::{
    apply_haircut, calculate_pnl, checked_mul_div,
    get_decimals_for_mint, get_haircut_for_mint, token_to_usd,
};
use crate::utils::token::{spl_transfer_signed, read_token_owner};
use crate::utils::account::{load_config, save_config, load_position, save_position};
use crate::events::{emit_position_liquidated, emit_psf_low};

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let params = LiquidateParams::deserialize(data)
        .ok_or(ProgramError::InvalidInstructionData)?;

    let iter = &mut accounts.iter();
    let liquidator = next_account_info(iter)?;
    let global_config_ai = next_account_info(iter)?;
    let position_ai = next_account_info(iter)?;
    let pyth_price_feed = next_account_info(iter)?;
    let collateral_vault = next_account_info(iter)?;           // index 4
    let liquidator_collateral_account = next_account_info(iter)?; // index 5
    let fee_recipient_collateral_account = next_account_info(iter)?; // index 6
    let program_authority = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    ensure!(liquidator.is_signer, AtomicPerpsError::Unauthorized);

    // Verify PDAs
    let (config_pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    ensure!(*global_config_ai.key == config_pda, AtomicPerpsError::BadInput);

    let (auth_pda, _) = Pubkey::find_program_address(&[AUTHORITY_SEED], program_id);
    ensure!(*program_authority.key == auth_pda, AtomicPerpsError::BadInput);

    let mut config = load_config(global_config_ai)?;

    // Validate fee recipient matches config
    let fee_recipient_owner = read_token_owner(fee_recipient_collateral_account)?;
    ensure!(fee_recipient_owner == config.fee_recipient, AtomicPerpsError::Unauthorized);

    let mut position = load_position(position_ai)?;

    ensure!(position.is_open, AtomicPerpsError::PositionNotOpen);
    ensure!(crate::constants::is_allowed_feed(pyth_price_feed.key), AtomicPerpsError::InvalidOracleFeed);
    ensure!(*pyth_price_feed.key == position.perp_market, AtomicPerpsError::InvalidOracleFeed);

    // Determine collateral type and validate vault
    let coll_mint = position.collateral_mint;
    let is_correlated = coll_mint == config.jlp_mint || coll_mint == config.msol_mint;
    let expected_vault = if coll_mint == config.jlp_mint {
        config.jlp_vault
    } else if coll_mint == config.msol_mint {
        config.msol_vault
    } else {
        config.sol_vault
    };
    ensure!(*collateral_vault.key == expected_vault, AtomicPerpsError::BadInput);

    // Verify position PDA
    let (expected_pos_pda, _) = Pubkey::find_program_address(
        &[POSITION_SEED, position.owner.as_ref(), pyth_price_feed.key.as_ref()],
        program_id,
    );
    ensure!(*position_ai.key == expected_pos_pda, AtomicPerpsError::BadInput);

    let coll_decimals = get_decimals_for_mint(&coll_mint);
    let haircut_bps = get_haircut_for_mint(&coll_mint);
    let collateral_amount = position.collateral_amount;

    // -------- 1. Oracle --------
    let clock = Clock::get()?;
    let (current_price, _conf) = validate_and_get_price(pyth_price_feed, &clock)?;

    // Get collateral price
    let collateral_price = if coll_mint == config.jlp_mint {
        validate_jlp_price(params.collateral_price_6dp, current_price)?;
        params.collateral_price_6dp
    } else if coll_mint == config.msol_mint {
        crate::utils::oracle::validate_msol_price(params.collateral_price_6dp, current_price)?;
        params.collateral_price_6dp
    } else {
        current_price
    };

    // -------- JLP grace period: cannot liquidate within 2h of opening --------
    if coll_mint == config.jlp_mint {
        let age = clock.unix_timestamp.saturating_sub(position.opened_at);
        ensure!(age >= JLP_LIQUIDATION_GRACE_SECONDS, AtomicPerpsError::LiquidationGracePeriod);
    }

    // -------- 2. Margin-based health check --------
    // For JLP: use max(entry_price, current_price) per A-04 — yield can only help
    let health_price = if coll_mint == config.jlp_mint {
        collateral_price.max(position.collateral_entry_price)
    } else {
        collateral_price
    };

    let pow = 10u64
        .checked_pow(coll_decimals as u32)
        .ok_or(AtomicPerpsError::MathOverflow)?;

    // Compute unrealized PnL (power-aware)
    let power = position.power_milli;
    let pnl = crate::utils::math::calculate_pnl_power(position.entry_price, current_price, position.perp_size, &position.perp_side, power)?;

    // Effective collateral = collateral +/- PnL (in collateral token units)
    let effective_coll = if pnl >= 0 {
        let pnl_coll = checked_mul_div(pnl as u64, pow, collateral_price.max(1))?;
        collateral_amount.saturating_add(pnl_coll)
    } else {
        let loss_coll = checked_mul_div((-pnl) as u64, pow, collateral_price.max(1))?;
        collateral_amount.saturating_sub(loss_coll)
    };

    // Effective margin in USD (with haircut)
    let effective_margin_usd = apply_haircut(
        token_to_usd(effective_coll, health_price, coll_decimals)?,
        haircut_bps,
    )?;

    // Notional value (borrow_amount_usdc is repurposed as notional)
    let notional = position.borrow_amount_usdc;

    // Margin ratio: effective_margin / notional * 10000
    let margin_ratio = if notional == 0 { u64::MAX } else {
        checked_mul_div(effective_margin_usd, BPS_DENOMINATOR, notional)?
    };

    // Position must be below maintenance margin to be liquidatable
    ensure!(margin_ratio < MAINTENANCE_MARGIN_BPS, AtomicPerpsError::PositionHealthy);

    // -------- 3. Gradual deleveraging — close percentage based on severity --------
    let close_bps: u64 = if margin_ratio < DELEVERAGE_ZONE_3_BPS {
        // Below 2%: full liquidation
        BPS_DENOMINATOR
    } else if margin_ratio < DELEVERAGE_ZONE_2_BPS {
        // 2-3%: close 75%
        7_500
    } else if margin_ratio < DELEVERAGE_ZONE_1_BPS {
        // 3-4%: close 50%
        5_000
    } else {
        // 4-5%: close 25%
        2_500
    };

    let closing_collateral = checked_mul_div(collateral_amount, close_bps, BPS_DENOMINATOR)?;
    let closing_size = checked_mul_div(position.perp_size, close_bps, BPS_DENOMINATOR)?;

    // Liquidator bonus on closed portion only
    let bonus_amount = checked_mul_div(closing_collateral, LIQUIDATION_BONUS_BPS, BPS_DENOMINATOR)?;
    let remainder = closing_collateral.saturating_sub(bonus_amount);

    let authority_bump = config.program_authority_bump;
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, &[authority_bump]];
    let signer_seeds: &[&[&[u8]]] = &[authority_seeds];

    if bonus_amount > 0 {
        spl_transfer_signed(token_program, collateral_vault, liquidator_collateral_account, program_authority, bonus_amount, signer_seeds)?;
    }

    if remainder > 0 {
        spl_transfer_signed(token_program, collateral_vault, fee_recipient_collateral_account, program_authority, remainder, signer_seeds)?;
    }

    emit_position_liquidated(
        &position.owner,
        liquidator.key,
        margin_ratio,
        closing_collateral,
    );

    // Decrement collateral tracking for closed portion
    let closing_usd = token_to_usd(closing_collateral, position.collateral_entry_price, coll_decimals).unwrap_or(0);
    config.total_collateral = config.total_collateral.saturating_sub(closing_usd);
    if is_correlated {
        config.total_correlated_collateral = config.total_correlated_collateral.saturating_sub(closing_usd);
    }

    match position.perp_side {
        crate::state::Side::Long => {
            config.total_long_oi = config.total_long_oi.saturating_sub(closing_size);
        }
        crate::state::Side::Short => {
            config.total_short_oi = config.total_short_oi.saturating_sub(closing_size);
        }
    }

    // PSF coverage warning — emit event if below 5% of total collateral
    let psf_threshold = config.total_collateral / 20;
    if config.psf_balance < psf_threshold {
        emit_psf_low(config.psf_balance, psf_threshold);
    }

    save_config(global_config_ai, &config)?;

    if close_bps >= BPS_DENOMINATOR {
        // Full liquidation — zero out position
        position.is_open = false;
        position.collateral_amount = 0;
        position.borrow_amount_usdc = 0;
        position.perp_size = 0;
    } else {
        // Partial deleverage — reduce position proportionally, keep open
        position.collateral_amount = position.collateral_amount.saturating_sub(closing_collateral);
        position.perp_size = position.perp_size.saturating_sub(closing_size);
        position.borrow_amount_usdc = position.perp_size; // notional = size
    }
    save_position(position_ai, &position)?;

    Ok(())
}
