use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::Sysvar,
};

pub struct LiquidateParams {
    pub kamino_repay_data: Vec<u8>,
    // V3: collateral price for JLP (0 = use oracle)
    pub collateral_price_6dp: u64,
}

impl LiquidateParams {
    fn deserialize(data: &[u8]) -> Option<Self> {
        if data.len() < 4 { return None; }
        let mut o = 0;
        let len = u32::from_le_bytes(data[o..o+4].try_into().unwrap()) as usize; o += 4;
        if data.len() < o + len { return None; }
        let kamino_repay_data = data[o..o+len].to_vec(); o += len;
        // V3 extension: collateral_price_6dp (8 bytes)
        let collateral_price_6dp = if o + 8 <= data.len() {
            u64::from_le_bytes(data[o..o+8].try_into().unwrap())
        } else {
            0
        };
        Some(Self { kamino_repay_data, collateral_price_6dp })
    }
}

use crate::errors::AtomicPerpsError;
use crate::constants::*;
use crate::ensure;
use crate::utils::oracle::{validate_and_get_price, validate_jlp_price};
use crate::utils::math::{
    apply_haircut, calculate_health_factor, checked_mul_div,
    get_decimals_for_mint, get_haircut_for_mint, token_to_usd,
};
use crate::utils::token::spl_transfer_signed;
use crate::utils::account::{load_config, save_config, load_position, save_position};
use crate::events::{emit_position_liquidated, emit_psf_low};
#[cfg(feature = "kamino-cpi")]
use crate::utils::cpi::kamino::cpi_repay;

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
    let collateral_vault = next_account_info(iter)?;           // index 4 (was sol_vault)
    let liquidator_collateral_account = next_account_info(iter)?; // index 5
    let fee_recipient_collateral_account = next_account_info(iter)?; // index 6
    let program_authority = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let remaining_accounts = &accounts[9..];

    ensure!(liquidator.is_signer, AtomicPerpsError::Unauthorized);

    // Verify PDAs
    let (config_pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    ensure!(*global_config_ai.key == config_pda, AtomicPerpsError::BadInput);

    let (auth_pda, _) = Pubkey::find_program_address(&[AUTHORITY_SEED], program_id);
    ensure!(*program_authority.key == auth_pda, AtomicPerpsError::BadInput);

    let mut config = load_config(global_config_ai)?;
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
        &[POSITION_SEED, position.owner.as_ref()],
        program_id,
    );
    ensure!(*position_ai.key == expected_pos_pda, AtomicPerpsError::BadInput);

    let coll_decimals = get_decimals_for_mint(&coll_mint);
    let haircut_bps = get_haircut_for_mint(&coll_mint);
    let collateral_amount = position.collateral_amount;
    let borrow_amount = position.borrow_amount_usdc;

    // -------- 1. Oracle --------
    let clock = Clock::get()?;
    let (current_price, _conf) = validate_and_get_price(pyth_price_feed, &clock)?;

    // Get collateral price
    let mut extra_remaining_offset: usize = 0;
    let collateral_price = if coll_mint == config.jlp_mint {
        validate_jlp_price(params.collateral_price_6dp, current_price)?;
        params.collateral_price_6dp
    } else if coll_mint == config.msol_mint {
        ensure!(!remaining_accounts.is_empty(), AtomicPerpsError::BadInput);
        let msol_feed = &remaining_accounts[0];
        ensure!(*msol_feed.key == config.pyth_msol_feed, AtomicPerpsError::InvalidOracleFeed);
        extra_remaining_offset = 1;
        let (msol_price, _) = crate::utils::oracle::validate_and_get_price_for_feed(
            msol_feed, &clock, &PYTH_MSOL_USD_FEED_ID,
        )?;
        msol_price
    } else {
        current_price
    };

    // -------- JLP grace period: cannot liquidate within 2h of opening --------
    if coll_mint == config.jlp_mint {
        let age = clock.unix_timestamp.saturating_sub(position.opened_at);
        ensure!(age >= JLP_LIQUIDATION_GRACE_SECONDS, AtomicPerpsError::LiquidationGracePeriod);
    }

    // -------- 2. Health check (with haircut) --------
    // For JLP: use max(entry_price, current_price) per A-04 — yield can only help
    let health_price = if coll_mint == config.jlp_mint {
        collateral_price.max(position.collateral_entry_price)
    } else {
        collateral_price
    };
    let collateral_usd = apply_haircut(
        token_to_usd(collateral_amount, health_price, coll_decimals)?,
        haircut_bps,
    )?;
    let health = calculate_health_factor(collateral_usd, borrow_amount, config.liquidation_threshold)?;
    ensure!(health < BPS_DENOMINATOR, AtomicPerpsError::PositionHealthy);

    // -------- 3. Split collateral --------
    let bonus_amount = checked_mul_div(collateral_amount, LIQUIDATION_BONUS_BPS, BPS_DENOMINATOR)?;
    let remainder = collateral_amount.saturating_sub(bonus_amount);

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
        health,
        collateral_amount,
    );

    let cpi_remaining = &remaining_accounts[extra_remaining_offset..];
    #[cfg(feature = "kamino-cpi")]
    if !params.kamino_repay_data.is_empty() {
        ensure!(cpi_remaining.len() >= 2, AtomicPerpsError::BadInput);
        let kamino_program = &cpi_remaining[0];
        let repay_accounts = &cpi_remaining[1..];
        cpi_repay(kamino_program, repay_accounts, &params.kamino_repay_data)?;
    }
    #[cfg(not(feature = "kamino-cpi"))]
    { let _ = &params; let _ = cpi_remaining; }

    // Decrement collateral tracking
    let deposit_usd = token_to_usd(collateral_amount, position.collateral_entry_price, coll_decimals).unwrap_or(0);
    config.total_collateral = config.total_collateral.saturating_sub(deposit_usd);
    if is_correlated {
        config.total_correlated_collateral = config.total_correlated_collateral.saturating_sub(deposit_usd);
    }

    config.total_usdc_borrowed = config.total_usdc_borrowed.saturating_sub(borrow_amount);
    match position.perp_side {
        crate::state::Side::Long => {
            config.total_long_oi = config.total_long_oi.saturating_sub(position.perp_size);
        }
        crate::state::Side::Short => {
            config.total_short_oi = config.total_short_oi.saturating_sub(position.perp_size);
        }
    }
    // PSF coverage warning — emit event if below 5% of reserve
    let psf_threshold = config.total_usdc_reserve / 20;
    if config.psf_balance < psf_threshold {
        emit_psf_low(config.psf_balance, psf_threshold);
    }

    save_config(global_config_ai, &config)?;

    position.is_open = false;
    position.collateral_amount = 0;
    position.borrow_amount_usdc = 0;
    position.perp_size = 0;
    save_position(position_ai, &position)?;

    Ok(())
}
