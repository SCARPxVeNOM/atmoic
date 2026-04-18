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
}

impl LiquidateParams {
    fn deserialize(data: &[u8]) -> Option<Self> {
        if data.len() < 4 { return None; }
        let len = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
        if data.len() < 4 + len { return None; }
        Some(Self { kamino_repay_data: data[4..4+len].to_vec() })
    }
}
use crate::errors::AtomicPerpsError;
use crate::constants::*;
use crate::ensure;
use crate::utils::oracle::validate_and_get_price;
use crate::utils::math::{calculate_health_factor, checked_mul_div, token_to_usd};
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
    let sol_vault = next_account_info(iter)?;
    let liquidator_sol_account = next_account_info(iter)?;
    let fee_recipient_sol_account = next_account_info(iter)?;
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
    ensure!(*sol_vault.key == config.sol_vault, AtomicPerpsError::BadInput);

    // Verify position PDA
    let (expected_pos_pda, _) = Pubkey::find_program_address(
        &[POSITION_SEED, position.owner.as_ref()],
        program_id,
    );
    ensure!(*position_ai.key == expected_pos_pda, AtomicPerpsError::BadInput);

    let collateral_amount = position.collateral_amount;
    let borrow_amount = position.borrow_amount_usdc;

    // -------- 1. Oracle --------
    let (current_price, _conf) = validate_and_get_price(pyth_price_feed, &Clock::get()?)?;

    // -------- 2. Health check --------
    let collateral_usd = token_to_usd(collateral_amount, current_price, SOL_DECIMALS)?;
    let health = calculate_health_factor(collateral_usd, borrow_amount, config.liquidation_threshold)?;
    ensure!(health < BPS_DENOMINATOR, AtomicPerpsError::PositionHealthy);

    // -------- 3. Split collateral --------
    let bonus_amount = checked_mul_div(collateral_amount, LIQUIDATION_BONUS_BPS, BPS_DENOMINATOR)?;
    let remainder = collateral_amount.saturating_sub(bonus_amount);

    let authority_bump = config.program_authority_bump;
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, &[authority_bump]];
    let signer_seeds: &[&[&[u8]]] = &[authority_seeds];

    if bonus_amount > 0 {
        spl_transfer_signed(token_program, sol_vault, liquidator_sol_account, program_authority, bonus_amount, signer_seeds)?;
    }

    if remainder > 0 {
        spl_transfer_signed(token_program, sol_vault, fee_recipient_sol_account, program_authority, remainder, signer_seeds)?;
    }

    emit_position_liquidated(
        &position.owner,
        liquidator.key,
        health,
        collateral_amount,
    );

    #[cfg(feature = "kamino-cpi")]
    if !params.kamino_repay_data.is_empty() {
        ensure!(remaining_accounts.len() >= 2, AtomicPerpsError::BadInput);
        let kamino_program = &remaining_accounts[0];
        let repay_accounts = &remaining_accounts[1..];
        cpi_repay(kamino_program, repay_accounts, &params.kamino_repay_data)?;
    }
    #[cfg(not(feature = "kamino-cpi"))]
    { let _ = &params; let _ = &remaining_accounts; }

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
