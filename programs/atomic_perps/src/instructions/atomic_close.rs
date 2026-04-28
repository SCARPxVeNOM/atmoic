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
use crate::constants::is_allowed_feed;
use crate::ensure;
use crate::utils::oracle::{validate_and_get_price, validate_jlp_price, validate_msol_price};
use crate::utils::math::{calculate_pnl, checked_mul_div, get_decimals_for_mint, token_to_usd, apply_haircut};
use crate::utils::token::{spl_transfer_signed, read_token_amount, read_token_owner};
use crate::utils::account::{load_config, save_config, load_position, save_position};
use crate::events::emit_position_closed;

pub struct AtomicCloseParams {
    pub close_bps: u16,            // 10000 = full close, 5000 = 50%, 1 = 0.01%
    pub collateral_price_6dp: u64, // JLP/mSOL price; 0 = use oracle
}

impl AtomicCloseParams {
    fn deserialize(data: &[u8]) -> Option<Self> {
        // u16(2) + u64(8) = 10 bytes
        if data.len() < 2 { return None; }
        let mut o = 0;
        let close_bps = u16::from_le_bytes(data[o..o+2].try_into().unwrap()); o += 2;
        let collateral_price_6dp = if o + 8 <= data.len() {
            u64::from_le_bytes(data[o..o+8].try_into().unwrap())
        } else {
            0
        };
        Some(Self { close_bps, collateral_price_6dp })
    }
}

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let params = AtomicCloseParams::deserialize(data)
        .ok_or(ProgramError::InvalidInstructionData)?;

    let iter = &mut accounts.iter();
    let user = next_account_info(iter)?;
    let global_config_ai = next_account_info(iter)?;
    let position_ai = next_account_info(iter)?;
    let pyth_price_feed = next_account_info(iter)?;
    let collateral_vault = next_account_info(iter)?;         // index 4
    let user_collateral_account = next_account_info(iter)?;  // index 5
    let fee_recipient_account = next_account_info(iter)?;    // index 6
    let program_authority = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;

    ensure!(user.is_signer, AtomicPerpsError::Unauthorized);

    // Validate close_bps: 1-10000
    ensure!(params.close_bps >= 1 && params.close_bps <= 10000, AtomicPerpsError::BadInput);

    // Verify PDAs
    let (config_pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    ensure!(*global_config_ai.key == config_pda, AtomicPerpsError::BadInput);

    let (position_pda, _) = Pubkey::find_program_address(
        &[POSITION_SEED, user.key.as_ref()], program_id,
    );
    ensure!(*position_ai.key == position_pda, AtomicPerpsError::BadInput);

    let (auth_pda, _) = Pubkey::find_program_address(&[AUTHORITY_SEED], program_id);
    ensure!(*program_authority.key == auth_pda, AtomicPerpsError::BadInput);

    let mut config = load_config(global_config_ai)?;

    // Validate fee recipient matches config
    let fee_recipient_owner = read_token_owner(fee_recipient_account)?;
    ensure!(fee_recipient_owner == config.fee_recipient, AtomicPerpsError::Unauthorized);

    let mut position = load_position(position_ai)?;

    ensure!(position.is_open, AtomicPerpsError::PositionNotOpen);
    ensure!(position.owner == *user.key, AtomicPerpsError::Unauthorized);
    ensure!(is_allowed_feed(pyth_price_feed.key), AtomicPerpsError::InvalidOracleFeed);
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

    let coll_decimals = get_decimals_for_mint(&coll_mint);
    let entry_price = position.entry_price;
    let perp_side = position.perp_side;

    // -------- 1. Oracle --------
    let clock = Clock::get()?;
    let (exit_price, _conf) = validate_and_get_price(pyth_price_feed, &clock)?;

    // Get collateral price for settlement
    let collateral_price = if coll_mint == config.jlp_mint {
        validate_jlp_price(params.collateral_price_6dp, exit_price)?;
        params.collateral_price_6dp
    } else if coll_mint == config.msol_mint {
        validate_msol_price(params.collateral_price_6dp, exit_price)?;
        params.collateral_price_6dp
    } else {
        exit_price
    };

    // -------- 2. Scale closing portion --------
    let close_ratio = params.close_bps as u64;
    let closing_collateral = checked_mul_div(position.collateral_amount, close_ratio, BPS_DENOMINATOR)?;
    let closing_size = checked_mul_div(position.perp_size, close_ratio, BPS_DENOMINATOR)?;

    let pow = 10u64
        .checked_pow(coll_decimals as u32)
        .ok_or(AtomicPerpsError::MathOverflow)?;

    // -------- 3. PnL on closing portion --------
    let pnl = calculate_pnl(entry_price, exit_price, closing_size, &perp_side)?;

    let pnl_in_collateral_abs: u64 = if pnl == 0 { 0 } else {
        checked_mul_div(pnl.unsigned_abs(), pow, collateral_price.max(1))?
    };

    // -------- 4. Close fee (on closing notional) --------
    let fee_usd = checked_mul_div(closing_size, config.protocol_fee_bps, BPS_DENOMINATOR)?;
    let fee_in_collateral = checked_mul_div(fee_usd, pow, collateral_price.max(1))?;

    // -------- 5. Settlement: closing_collateral - fee +/- PnL --------
    let mut collateral_to_return = closing_collateral.saturating_sub(fee_in_collateral);
    if pnl > 0 {
        collateral_to_return = collateral_to_return.saturating_add(pnl_in_collateral_abs);
        // Cap at vault balance to prevent over-withdrawal
        let vault_amount = read_token_amount(collateral_vault)?;
        collateral_to_return = collateral_to_return.min(vault_amount);
    } else if pnl < 0 {
        collateral_to_return = collateral_to_return.saturating_sub(pnl_in_collateral_abs);
    }

    let authority_bump = config.program_authority_bump;
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, &[authority_bump]];
    let signer_seeds: &[&[&[u8]]] = &[authority_seeds];

    // -------- 6. Fee transfer: vault -> fee_recipient (90%) + PSF accrual (10%) --------
    let psf_portion_coll = fee_in_collateral / 10;
    let recipient_fee_coll = fee_in_collateral.saturating_sub(psf_portion_coll);
    if recipient_fee_coll > 0 {
        spl_transfer_signed(token_program, collateral_vault, fee_recipient_account, program_authority, recipient_fee_coll, signer_seeds)?;
    }
    // PSF accrual in USD equivalent (accounting only)
    config.psf_balance = config.psf_balance.saturating_add(fee_usd / 10);

    // -------- 7. Return collateral to user --------
    if collateral_to_return > 0 {
        spl_transfer_signed(token_program, collateral_vault, user_collateral_account, program_authority, collateral_to_return, signer_seeds)?;
    }

    emit_position_closed(
        &position.owner,
        exit_price,
        pnl,
        collateral_to_return,
    );

    // -------- 8. Update position (partial or full close) --------
    // Decrement collateral tracking for the closing portion
    let closing_collateral_usd = token_to_usd(closing_collateral, position.collateral_entry_price, coll_decimals).unwrap_or(0);
    config.total_collateral = config.total_collateral.saturating_sub(closing_collateral_usd);
    if is_correlated {
        config.total_correlated_collateral = config.total_correlated_collateral.saturating_sub(closing_collateral_usd);
    }

    // Decrement OI by closing size
    match perp_side {
        crate::state::Side::Long => {
            config.total_long_oi = config.total_long_oi.saturating_sub(closing_size);
        }
        crate::state::Side::Short => {
            config.total_short_oi = config.total_short_oi.saturating_sub(closing_size);
        }
    }

    if params.close_bps >= 10000 {
        // Full close
        position.is_open = false;
        position.collateral_amount = 0;
        position.borrow_amount_usdc = 0;
        position.perp_size = 0;
    } else {
        // Partial close — reduce position proportionally
        position.collateral_amount = position.collateral_amount.saturating_sub(closing_collateral);
        position.perp_size = position.perp_size.saturating_sub(closing_size);
        position.borrow_amount_usdc = position.perp_size; // notional = perp_size

        // Post-close margin check on remaining position
        let remaining_coll_usd = apply_haircut(
            token_to_usd(position.collateral_amount, collateral_price, coll_decimals)?,
            crate::utils::math::get_haircut_for_mint(&coll_mint),
        )?;
        if position.perp_size > 0 {
            let remaining_margin = checked_mul_div(remaining_coll_usd, BPS_DENOMINATOR, position.perp_size)?;
            ensure!(remaining_margin >= MAINTENANCE_MARGIN_BPS, AtomicPerpsError::PositionUnhealthy);
        }
    }

    save_config(global_config_ai, &config)?;
    save_position(position_ai, &position)?;

    Ok(())
}
