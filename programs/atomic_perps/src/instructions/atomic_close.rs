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
use crate::utils::oracle::validate_and_get_price;
use crate::utils::math::{apply_fee, calculate_pnl, checked_mul_div};
use crate::utils::token::{spl_transfer, spl_transfer_signed, read_token_amount};
use crate::utils::account::{load_config, save_config, load_position, save_position};
use crate::events::emit_position_closed;
#[cfg(feature = "kamino-cpi")]
use crate::utils::cpi::kamino::cpi_repay;

pub struct AtomicCloseParams {
    pub kamino_repay_data: Vec<u8>,
}

impl AtomicCloseParams {
    fn deserialize(data: &[u8]) -> Option<Self> {
        if data.len() < 4 { return None; }
        let len = u32::from_le_bytes(data[0..4].try_into().unwrap()) as usize;
        if data.len() < 4 + len { return None; }
        Some(Self { kamino_repay_data: data[4..4+len].to_vec() })
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
    let user_usdc_account = next_account_info(iter)?;
    let usdc_reserve = next_account_info(iter)?;
    let sol_vault = next_account_info(iter)?;
    let user_sol_account = next_account_info(iter)?;
    let fee_recipient_account = next_account_info(iter)?;
    let program_authority = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    // remaining_accounts after index 10
    let remaining_accounts = &accounts[11..];

    ensure!(user.is_signer, AtomicPerpsError::Unauthorized);

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
    let mut position = load_position(position_ai)?;

    ensure!(position.is_open, AtomicPerpsError::PositionNotOpen);
    ensure!(position.owner == *user.key, AtomicPerpsError::Unauthorized);
    ensure!(is_allowed_feed(pyth_price_feed.key), AtomicPerpsError::InvalidOracleFeed);
    ensure!(*pyth_price_feed.key == position.perp_market, AtomicPerpsError::InvalidOracleFeed);
    ensure!(*usdc_reserve.key == config.usdc_reserve, AtomicPerpsError::BadInput);
    ensure!(*sol_vault.key == config.sol_vault, AtomicPerpsError::BadInput);

    let entry_price = position.entry_price;
    let perp_size = position.perp_size;
    let perp_side = position.perp_side;
    let borrow_amount = position.borrow_amount_usdc;
    let collateral_amount = position.collateral_amount;

    // -------- 1. Oracle --------
    let (exit_price, _conf) = validate_and_get_price(pyth_price_feed, &Clock::get()?)?;

    // -------- 2. PnL --------
    let pnl = calculate_pnl(entry_price, exit_price, perp_size, &perp_side)?;

    // -------- 3. Repay --------
    spl_transfer(token_program, user_usdc_account, usdc_reserve, user, borrow_amount)?;

    // -------- 4. Settle PnL --------
    let pnl_in_sol_abs: u64 = if pnl == 0 {
        0
    } else {
        let pow = 10u64
            .checked_pow(SOL_DECIMALS as u32)
            .ok_or(AtomicPerpsError::MathOverflow)?;
        checked_mul_div(pnl.unsigned_abs(), pow, exit_price.max(1))?
    };

    let mut collateral_to_return = collateral_amount;
    if pnl > 0 {
        collateral_to_return = collateral_to_return
            .checked_add(pnl_in_sol_abs)
            .ok_or(AtomicPerpsError::MathOverflow)?;
        let vault_amount = read_token_amount(sol_vault)?;
        collateral_to_return = collateral_to_return.min(vault_amount);
    } else if pnl < 0 {
        collateral_to_return = collateral_to_return.saturating_sub(pnl_in_sol_abs);
    }

    let (_rem, fee_amount_usdc) = apply_fee(borrow_amount, config.protocol_fee_bps)?;

    let authority_bump = config.program_authority_bump;
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, &[authority_bump]];
    let signer_seeds: &[&[&[u8]]] = &[authority_seeds];

    if fee_amount_usdc > 0 {
        spl_transfer_signed(token_program, usdc_reserve, fee_recipient_account, program_authority, fee_amount_usdc, signer_seeds)?;
    }

    if collateral_to_return > 0 {
        spl_transfer_signed(token_program, sol_vault, user_sol_account, program_authority, collateral_to_return, signer_seeds)?;
    }

    // Kamino CPI
    #[cfg(feature = "kamino-cpi")]
    if !params.kamino_repay_data.is_empty() {
        ensure!(remaining_accounts.len() >= 2, AtomicPerpsError::BadInput);
        let kamino_program = &remaining_accounts[0];
        let repay_accounts = &remaining_accounts[1..];
        cpi_repay(kamino_program, repay_accounts, &params.kamino_repay_data)?;
    }
    #[cfg(not(feature = "kamino-cpi"))]
    let _ = &params;

    emit_position_closed(
        &position.owner,
        exit_price,
        pnl,
        collateral_to_return,
    );

    config.total_usdc_borrowed = config.total_usdc_borrowed.saturating_sub(borrow_amount);
    match perp_side {
        crate::state::Side::Long => {
            config.total_long_oi = config.total_long_oi.saturating_sub(perp_size);
        }
        crate::state::Side::Short => {
            config.total_short_oi = config.total_short_oi.saturating_sub(perp_size);
        }
    }
    save_config(global_config_ai, &config)?;

    position.is_open = false;
    position.collateral_amount = 0;
    position.borrow_amount_usdc = 0;
    position.perp_size = 0;
    save_position(position_ai, &position)?;

    Ok(())
}
