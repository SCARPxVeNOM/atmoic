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
use crate::utils::oracle::{validate_and_get_price, validate_jlp_price};
use crate::utils::math::{apply_fee, calculate_pnl, checked_mul_div, get_decimals_for_mint, token_to_usd};
use crate::utils::token::{spl_transfer, spl_transfer_signed, read_token_amount};
use crate::utils::account::{load_config, save_config, load_position, save_position};
use crate::events::emit_position_closed;
#[cfg(feature = "kamino-cpi")]
use crate::utils::cpi::kamino::cpi_repay;

pub struct AtomicCloseParams {
    pub kamino_repay_data: Vec<u8>,
    // V3: JLP price for collateral settlement (0 = use oracle)
    pub collateral_price_6dp: u64,
}

impl AtomicCloseParams {
    fn deserialize(data: &[u8]) -> Option<Self> {
        if data.len() < 4 { return None; }
        let mut o = 0;
        let len = u32::from_le_bytes(data[o..o+4].try_into().unwrap()) as usize; o += 4;
        if data.len() < o + len { return None; }
        let kamino_repay_data = data[o..o+len].to_vec(); o += len;
        // V3 extension: collateral_price_6dp (8 bytes) — default 0 if absent
        let collateral_price_6dp = if o + 8 <= data.len() {
            u64::from_le_bytes(data[o..o+8].try_into().unwrap())
        } else {
            0
        };
        Some(Self { kamino_repay_data, collateral_price_6dp })
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
    let collateral_vault = next_account_info(iter)?;    // index 6 (was sol_vault)
    let user_collateral_account = next_account_info(iter)?; // index 7 (was user_sol_account)
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

    // Determine collateral type from position and validate vault
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
    let perp_size = position.perp_size;
    let perp_side = position.perp_side;
    let borrow_amount = position.borrow_amount_usdc;
    let collateral_amount = position.collateral_amount;

    // -------- 1. Oracle --------
    let clock = Clock::get()?;
    let (exit_price, _conf) = validate_and_get_price(pyth_price_feed, &clock)?;

    // Get collateral price for PnL settlement
    let mut extra_remaining_offset: usize = 0;
    let collateral_price = if coll_mint == config.jlp_mint {
        // JLP: price from instruction data, validated
        validate_jlp_price(params.collateral_price_6dp, exit_price)?;
        params.collateral_price_6dp
    } else if coll_mint == config.msol_mint {
        // mSOL: from Pyth mSOL feed in remaining_accounts[0]
        ensure!(!remaining_accounts.is_empty(), AtomicPerpsError::BadInput);
        let msol_feed = &remaining_accounts[0];
        ensure!(*msol_feed.key == config.pyth_msol_feed, AtomicPerpsError::InvalidOracleFeed);
        extra_remaining_offset = 1;
        let (msol_price, _) = crate::utils::oracle::validate_and_get_price_for_feed(
            msol_feed, &clock, &PYTH_MSOL_USD_FEED_ID,
        )?;
        msol_price
    } else {
        // SOL: use the perp market exit price
        exit_price
    };

    // -------- 2. PnL --------
    let pnl = calculate_pnl(entry_price, exit_price, perp_size, &perp_side)?;

    // -------- 3. Repay --------
    spl_transfer(token_program, user_usdc_account, usdc_reserve, user, borrow_amount)?;

    // -------- 4. Settle PnL in collateral units --------
    let pnl_in_collateral_abs: u64 = if pnl == 0 {
        0
    } else {
        let pow = 10u64
            .checked_pow(coll_decimals as u32)
            .ok_or(AtomicPerpsError::MathOverflow)?;
        checked_mul_div(pnl.unsigned_abs(), pow, collateral_price.max(1))?
    };

    let mut collateral_to_return = collateral_amount;
    if pnl > 0 {
        collateral_to_return = collateral_to_return
            .checked_add(pnl_in_collateral_abs)
            .ok_or(AtomicPerpsError::MathOverflow)?;
        let vault_amount = read_token_amount(collateral_vault)?;
        collateral_to_return = collateral_to_return.min(vault_amount);
    } else if pnl < 0 {
        collateral_to_return = collateral_to_return.saturating_sub(pnl_in_collateral_abs);
    }

    let (_rem, fee_amount_usdc) = apply_fee(borrow_amount, config.protocol_fee_bps)?;

    let authority_bump = config.program_authority_bump;
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, &[authority_bump]];
    let signer_seeds: &[&[&[u8]]] = &[authority_seeds];

    // PSF accrual: 10% of fee stays in reserve, 90% to fee_recipient (F-02 R-3)
    let psf_portion = fee_amount_usdc / 10;
    let recipient_fee = fee_amount_usdc.saturating_sub(psf_portion);

    if recipient_fee > 0 {
        spl_transfer_signed(token_program, usdc_reserve, fee_recipient_account, program_authority, recipient_fee, signer_seeds)?;
    }
    config.psf_balance = config.psf_balance.saturating_add(psf_portion);

    if collateral_to_return > 0 {
        spl_transfer_signed(token_program, collateral_vault, user_collateral_account, program_authority, collateral_to_return, signer_seeds)?;
    }

    // Kamino CPI
    let cpi_remaining = &remaining_accounts[extra_remaining_offset..];
    #[cfg(feature = "kamino-cpi")]
    if !params.kamino_repay_data.is_empty() {
        ensure!(cpi_remaining.len() >= 2, AtomicPerpsError::BadInput);
        let kamino_program = &cpi_remaining[0];
        let repay_accounts = &cpi_remaining[1..];
        cpi_repay(kamino_program, repay_accounts, &params.kamino_repay_data)?;
    }
    #[cfg(not(feature = "kamino-cpi"))]
    let _ = (&params, cpi_remaining);

    emit_position_closed(
        &position.owner,
        exit_price,
        pnl,
        collateral_to_return,
    );

    // Decrement collateral tracking
    let deposit_usd = token_to_usd(collateral_amount, position.collateral_entry_price, coll_decimals).unwrap_or(0);
    config.total_collateral = config.total_collateral.saturating_sub(deposit_usd);
    if is_correlated {
        config.total_correlated_collateral = config.total_correlated_collateral.saturating_sub(deposit_usd);
    }

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
