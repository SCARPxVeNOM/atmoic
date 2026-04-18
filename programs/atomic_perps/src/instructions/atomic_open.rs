use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::Sysvar,
};
use crate::state::{Position, Side};
use crate::errors::AtomicPerpsError;
use crate::constants::*;
use crate::ensure;
use crate::utils::oracle::validate_and_get_price;
use crate::utils::math::{
    apply_fee, calculate_health_factor, calculate_min_spread, calculate_position_size,
    check_vault_skew, token_to_usd,
};
use crate::utils::token::{spl_transfer, spl_transfer_signed};
use crate::utils::account::{create_pda_account, load_config, save_config, save_position};
use crate::events::emit_position_opened;
#[cfg(feature = "kamino-cpi")]
use crate::utils::cpi::kamino::cpi_borrow;
use crate::utils::cpi::jupiter::cpi_swap;
use crate::constants::is_allowed_feed;

pub struct AtomicOpenParams {
    pub collateral_amount: u64,
    pub borrow_amount: u64,
    pub perp_side: Side,
    pub leverage_bps: u64,
    pub hedge_amount: u64,
    pub spread_fee_bps: u16,
    pub jupiter_swap_data: Vec<u8>,
    pub kamino_borrow_data: Vec<u8>,
}

impl AtomicOpenParams {
    fn deserialize(data: &[u8]) -> Option<Self> {
        if data.len() < 35 { return None; } // 5*u64(8) + side(1) + spread(2) + 2*vec_header(4)
        let mut o = 0;
        let u = |d: &[u8], o: &mut usize| -> u64 {
            let v = u64::from_le_bytes(d[*o..*o+8].try_into().unwrap()); *o += 8; v
        };
        let collateral_amount = u(data, &mut o);
        let borrow_amount = u(data, &mut o);
        let perp_side = Side::from_u8(data[o])?; o += 1;
        let leverage_bps = u(data, &mut o);
        let hedge_amount = u(data, &mut o);
        // spread_fee_bps: u16 LE (2 bytes) — backward-compatible default 5 if data too short
        let spread_fee_bps = if o + 2 <= data.len() {
            let v = u16::from_le_bytes(data[o..o+2].try_into().unwrap()); o += 2; v
        } else {
            5 // default minimum spread
        };
        // Vec<u8>: 4-byte LE length + data
        if o + 4 > data.len() { return None; }
        let jlen = u32::from_le_bytes(data[o..o+4].try_into().unwrap()) as usize; o += 4;
        if o + jlen > data.len() { return None; }
        let jupiter_swap_data = data[o..o+jlen].to_vec(); o += jlen;
        if o + 4 > data.len() { return None; }
        let klen = u32::from_le_bytes(data[o..o+4].try_into().unwrap()) as usize; o += 4;
        if o + klen > data.len() { return None; }
        let kamino_borrow_data = data[o..o+klen].to_vec();
        Some(Self { collateral_amount, borrow_amount, perp_side, leverage_bps, hedge_amount, spread_fee_bps, jupiter_swap_data, kamino_borrow_data })
    }
}

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let params = AtomicOpenParams::deserialize(data)
        .ok_or(ProgramError::InvalidInstructionData)?;

    let iter = &mut accounts.iter();
    let user = next_account_info(iter)?;
    let global_config_ai = next_account_info(iter)?;
    let position_ai = next_account_info(iter)?;
    let pyth_price_feed = next_account_info(iter)?;
    let user_sol_account = next_account_info(iter)?;
    let sol_vault = next_account_info(iter)?;
    let usdc_reserve = next_account_info(iter)?;
    let user_usdc_account = next_account_info(iter)?;
    let fee_recipient_account = next_account_info(iter)?;
    let program_authority = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;
    // remaining_accounts are everything after index 11
    let remaining_accounts = &accounts[12..];

    ensure!(user.is_signer, AtomicPerpsError::Unauthorized);

    // Verify PDAs
    let (config_pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    ensure!(*global_config_ai.key == config_pda, AtomicPerpsError::BadInput);

    let (position_pda, position_bump) = Pubkey::find_program_address(
        &[POSITION_SEED, user.key.as_ref()], program_id,
    );
    ensure!(*position_ai.key == position_pda, AtomicPerpsError::BadInput);

    let (auth_pda, _) = Pubkey::find_program_address(&[AUTHORITY_SEED], program_id);
    ensure!(*program_authority.key == auth_pda, AtomicPerpsError::BadInput);

    let mut config = load_config(global_config_ai)?;

    // -------- 1. Input validation --------
    ensure!(!config.is_paused, AtomicPerpsError::ProtocolPaused);
    ensure!(params.collateral_amount > 0, AtomicPerpsError::InsufficientCollateral);
    ensure!(params.borrow_amount > 0, AtomicPerpsError::InsufficientCollateral);
    ensure!(params.leverage_bps <= config.max_leverage, AtomicPerpsError::ExcessiveLeverage);
    ensure!(params.hedge_amount <= params.borrow_amount, AtomicPerpsError::InsufficientCollateral);

    ensure!(is_allowed_feed(pyth_price_feed.key), AtomicPerpsError::InvalidOracleFeed);
    ensure!(*sol_vault.key == config.sol_vault, AtomicPerpsError::BadInput);
    ensure!(*usdc_reserve.key == config.usdc_reserve, AtomicPerpsError::BadInput);

    // -------- 1b. Dynamic spread check (M-2) — rejects if skew >90% --------
    check_vault_skew(config.total_long_oi, config.total_short_oi)?;

    // -------- 1c. Spread fee enforcement — caller must pay at least the min spread --------
    let min_spread = calculate_min_spread(config.total_long_oi, config.total_short_oi);
    ensure!(params.spread_fee_bps >= min_spread, AtomicPerpsError::BadInput);

    // -------- 2. Oracle --------
    let (sol_price_6dp, _conf) = validate_and_get_price(pyth_price_feed, &Clock::get()?)?;

    let collateral_usd = token_to_usd(params.collateral_amount, sol_price_6dp, SOL_DECIMALS)?;

    let implied_leverage_bps = crate::utils::math::checked_mul_div(
        params.borrow_amount, 1_000, collateral_usd.max(1),
    )?;
    ensure!(implied_leverage_bps <= config.max_leverage, AtomicPerpsError::ExcessiveLeverage);

    // -------- 3. TVL checks --------
    let new_total_borrowed = config.total_usdc_borrowed
        .checked_add(params.borrow_amount)
        .ok_or(AtomicPerpsError::MathOverflow)?;
    ensure!(new_total_borrowed <= config.total_usdc_reserve, AtomicPerpsError::InsufficientCollateral);
    ensure!(new_total_borrowed <= config.max_tvl, AtomicPerpsError::TVLCapExceeded);

    // -------- 3b. OI hard cap: total OI must not exceed 80% of reserve (F-03 R-2) --------
    let preview_size = calculate_position_size(params.borrow_amount, params.leverage_bps)?;
    let new_total_oi = match params.perp_side {
        Side::Long => config.total_long_oi.saturating_add(preview_size)
            .saturating_add(config.total_short_oi),
        Side::Short => config.total_long_oi
            .saturating_add(config.total_short_oi.saturating_add(preview_size)),
    };
    let oi_cap = config.total_usdc_reserve * 80 / 100;
    ensure!(new_total_oi <= oi_cap, AtomicPerpsError::TVLCapExceeded);

    // -------- 3c. PSF health check — warn if balance < 5% of reserve (F-02) --------
    let min_psf = config.total_usdc_reserve / 20;
    if config.psf_balance < min_psf {
        crate::events::emit_psf_low(config.psf_balance, min_psf);
    }

    // -------- 4. Collateral: user -> sol_vault --------
    spl_transfer(token_program, user_sol_account, sol_vault, user, params.collateral_amount)?;

    // -------- 5. Fee + borrow --------
    let total_fee_bps = config.protocol_fee_bps.saturating_add(params.spread_fee_bps as u64);
    let (user_recv_amount, fee_amount) = apply_fee(params.borrow_amount, total_fee_bps)?;

    let authority_bump = config.program_authority_bump;
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, &[authority_bump]];
    let signer_seeds: &[&[&[u8]]] = &[authority_seeds];

    spl_transfer_signed(token_program, usdc_reserve, user_usdc_account, program_authority, user_recv_amount, signer_seeds)?;

    if fee_amount > 0 {
        spl_transfer_signed(token_program, usdc_reserve, fee_recipient_account, program_authority, fee_amount, signer_seeds)?;
    }

    // -------- 6. Optional Kamino CPI --------
    let mut kamino_acct_count: usize = 0;
    #[cfg(feature = "kamino-cpi")]
    if !params.kamino_borrow_data.is_empty() {
        ensure!(remaining_accounts.len() >= 2, AtomicPerpsError::BadInput);
        let kamino_program = &remaining_accounts[0];
        let borrow_accounts = &remaining_accounts[1..];
        kamino_acct_count = 1 + borrow_accounts.len();
        cpi_borrow(kamino_program, borrow_accounts, &params.kamino_borrow_data)?;
    }

    // -------- 7. Optional Jupiter hedge (runs AFTER kamino, not exclusive) --------
    if params.hedge_amount > 0 && !params.jupiter_swap_data.is_empty() {
        let jupiter_accounts = &remaining_accounts[kamino_acct_count..];
        ensure!(jupiter_accounts.len() >= 2, AtomicPerpsError::BadInput);
        let jupiter_program = &jupiter_accounts[0];
        let swap_accounts = &jupiter_accounts[1..];
        cpi_swap(jupiter_program, swap_accounts, &params.jupiter_swap_data)?;
    }

    // -------- 8. Create + record position --------
    let perp_size = calculate_position_size(params.borrow_amount, params.leverage_bps)?;
    let now = Clock::get()?.unix_timestamp;

    let user_key = *user.key;
    let pos_seeds: &[&[u8]] = &[POSITION_SEED, user_key.as_ref(), &[position_bump]];
    create_pda_account(
        user,
        position_ai,
        system_program,
        8 + Position::INIT_SPACE,
        program_id,
        pos_seeds,
    )?;

    let position = Position {
        owner: user_key,
        perp_market: *pyth_price_feed.key,
        collateral_mint: config.sol_mint,
        // Phase 1: reserved for Kamino obligation PDA tracking
        kamino_obligation: Pubkey::default(),
        collateral_amount: params.collateral_amount,
        borrow_amount_usdc: params.borrow_amount,
        perp_side: params.perp_side,
        perp_size,
        entry_price: sol_price_6dp,
        opened_at: now,
        hedge_amount: params.hedge_amount,
        is_open: true,
        bump: position_bump,
    };

    // -------- 9. Post-state health check --------
    let post_collateral_usd = token_to_usd(position.collateral_amount, sol_price_6dp, SOL_DECIMALS)?;
    let health = calculate_health_factor(
        post_collateral_usd,
        position.borrow_amount_usdc,
        config.liquidation_threshold,
    )?;
    ensure!(health >= BPS_DENOMINATOR, AtomicPerpsError::PositionUnhealthy);

    save_position(position_ai, &position)?;

    // -------- 10. Update global accounting + OI --------
    config.total_usdc_borrowed = new_total_borrowed;
    match position.perp_side {
        crate::state::Side::Long => {
            config.total_long_oi = config.total_long_oi.saturating_add(perp_size);
        }
        crate::state::Side::Short => {
            config.total_short_oi = config.total_short_oi.saturating_add(perp_size);
        }
    }
    save_config(global_config_ai, &config)?;

    emit_position_opened(
        &position.owner,
        position.collateral_amount,
        position.borrow_amount_usdc,
        position.perp_side as u8,
        position.entry_price,
        params.leverage_bps,
    );

    Ok(())
}
