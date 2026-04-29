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
use crate::utils::oracle::{validate_and_get_price, validate_jlp_price, validate_msol_price};
use crate::utils::math::{
    apply_haircut, calculate_notional, check_vault_skew,
    checked_mul_div, token_to_usd,
    calculate_min_spread,
};
use crate::utils::token::{spl_transfer, spl_transfer_signed, read_token_owner};
use crate::utils::account::{create_pda_account, load_config, load_position, save_config, save_position};
use crate::events::emit_position_opened;
use crate::constants::is_allowed_feed;

pub struct AtomicOpenParams {
    pub collateral_amount: u64,
    pub perp_side: Side,
    pub leverage_bps: u64,       // 1000=1x, 5000=5x, 10000=10x
    pub spread_fee_bps: u16,
    pub collateral_type: u8,     // 0=SOL, 1=JLP, 2=mSOL
    pub collateral_price_6dp: u64, // JLP/mSOL price; 0 = use oracle
}

impl AtomicOpenParams {
    fn deserialize(data: &[u8]) -> Option<Self> {
        // u64(8) + u8(1) + u64(8) + u16(2) + u8(1) + u64(8) = 28 bytes
        if data.len() < 28 { return None; }
        let mut o = 0;
        let u = |d: &[u8], o: &mut usize| -> u64 {
            let v = u64::from_le_bytes(d[*o..*o+8].try_into().unwrap()); *o += 8; v
        };
        let collateral_amount = u(data, &mut o);
        let perp_side = Side::from_u8(data[o])?; o += 1;
        let leverage_bps = u(data, &mut o);
        let spread_fee_bps = u16::from_le_bytes(data[o..o+2].try_into().unwrap()); o += 2;
        let collateral_type = data[o]; o += 1;
        let collateral_price_6dp = u(data, &mut o);

        Some(Self { collateral_amount, perp_side, leverage_bps, spread_fee_bps, collateral_type, collateral_price_6dp })
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
    let user_collateral_account = next_account_info(iter)?;  // index 4
    let collateral_vault = next_account_info(iter)?;          // index 5
    let fee_recipient_account = next_account_info(iter)?;     // index 6
    let program_authority = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    ensure!(user.is_signer, AtomicPerpsError::Unauthorized);

    // Verify PDAs
    let (config_pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    ensure!(*global_config_ai.key == config_pda, AtomicPerpsError::BadInput);

    let (position_pda, position_bump) = Pubkey::find_program_address(
        &[POSITION_SEED, user.key.as_ref(), pyth_price_feed.key.as_ref()], program_id,
    );
    ensure!(*position_ai.key == position_pda, AtomicPerpsError::BadInput);

    let (auth_pda, _) = Pubkey::find_program_address(&[AUTHORITY_SEED], program_id);
    ensure!(*program_authority.key == auth_pda, AtomicPerpsError::BadInput);

    let mut config = load_config(global_config_ai)?;

    // Validate fee recipient matches config
    let fee_recipient_owner = read_token_owner(fee_recipient_account)?;
    ensure!(fee_recipient_owner == config.fee_recipient, AtomicPerpsError::Unauthorized);

    // -------- 1. Input validation --------
    ensure!(!config.is_paused, AtomicPerpsError::ProtocolPaused);
    ensure!(params.collateral_amount > 0, AtomicPerpsError::InsufficientCollateral);
    ensure!(params.leverage_bps >= 1_000, AtomicPerpsError::BadInput); // min 1x
    ensure!(params.leverage_bps <= config.max_leverage, AtomicPerpsError::ExcessiveLeverage);

    ensure!(is_allowed_feed(pyth_price_feed.key), AtomicPerpsError::InvalidOracleFeed);

    // -------- 1a. Determine collateral config from collateral_type --------
    let (coll_mint, coll_decimals, haircut_bps, expected_vault, is_correlated) = match params.collateral_type {
        0 => (config.sol_mint, SOL_DECIMALS, HAIRCUT_SOL_BPS, config.sol_vault, false),
        1 => {
            ensure!(config.jlp_vault != Pubkey::default(), AtomicPerpsError::BadInput);
            (config.jlp_mint, JLP_DECIMALS, HAIRCUT_JLP_BPS, config.jlp_vault, true)
        }
        2 => {
            ensure!(config.msol_vault != Pubkey::default(), AtomicPerpsError::BadInput);
            (config.msol_mint, MSOL_DECIMALS, HAIRCUT_MSOL_BPS, config.msol_vault, true)
        }
        _ => return Err(AtomicPerpsError::InvalidCollateralMint.into()),
    };

    // Validate collateral vault matches config
    ensure!(*collateral_vault.key == expected_vault, AtomicPerpsError::BadInput);

    // -------- 1b. Stress check — block correlated collateral during stress --------
    if config.stress_active && is_correlated {
        crate::events::emit_stress_triggered(user.key, params.collateral_type);
        return Err(AtomicPerpsError::StressActive.into());
    }

    // -------- 1c. Directional skew check (M-2) — blocks only skew-increasing fills >90% --------
    check_vault_skew(config.total_long_oi, config.total_short_oi, &params.perp_side)?;

    // -------- 1d. Spread fee enforcement — caller must pay at least the min spread --------
    let min_spread = calculate_min_spread(config.total_long_oi, config.total_short_oi);
    ensure!(params.spread_fee_bps >= min_spread, AtomicPerpsError::BadInput);

    // -------- 2. Oracle --------
    let clock = Clock::get()?;
    let (sol_price_6dp, _conf) = validate_and_get_price(pyth_price_feed, &clock)?;

    // Get collateral price (may differ from SOL for JLP/mSOL)
    let collateral_price_6dp = match params.collateral_type {
        0 => sol_price_6dp,
        1 => {
            validate_jlp_price(params.collateral_price_6dp, sol_price_6dp)?;
            params.collateral_price_6dp
        }
        2 => {
            validate_msol_price(params.collateral_price_6dp, sol_price_6dp)?;
            params.collateral_price_6dp
        }
        _ => unreachable!(),
    };

    // -------- 3. Compute notional and fee --------
    // Collateral value in USD (raw, before haircut)
    let raw_collateral_usd = token_to_usd(params.collateral_amount, collateral_price_6dp, coll_decimals)?;

    // Notional = collateral_usd × leverage
    let notional_usd = calculate_notional(raw_collateral_usd, params.leverage_bps)?;

    // Fee: charged on notional, converted to collateral tokens
    let total_fee_bps = config.protocol_fee_bps.saturating_add(params.spread_fee_bps as u64);
    let fee_usd = checked_mul_div(notional_usd, total_fee_bps, BPS_DENOMINATOR)?;
    let pow = 10u64.checked_pow(coll_decimals as u32).ok_or(AtomicPerpsError::MathOverflow)?;
    let fee_in_collateral = checked_mul_div(fee_usd, pow, collateral_price_6dp.max(1))?;

    // Net collateral after fee
    let net_collateral = params.collateral_amount
        .checked_sub(fee_in_collateral)
        .ok_or(AtomicPerpsError::InsufficientCollateral)?;
    ensure!(net_collateral > 0, AtomicPerpsError::InsufficientCollateral);

    // -------- 3b. Correlated cap check --------
    if is_correlated {
        let new_corr = config.total_correlated_collateral.saturating_add(raw_collateral_usd);
        let new_total = config.total_collateral.saturating_add(raw_collateral_usd);
        if new_total > 0 {
            let corr_pct_bps = checked_mul_div(new_corr, BPS_DENOMINATOR, new_total)?;
            if corr_pct_bps > CORRELATED_CAP_BPS {
                crate::events::emit_correlated_cap_hit(user.key, corr_pct_bps, CORRELATED_CAP_BPS);
                return Err(AtomicPerpsError::CorrelatedCapExceeded.into());
            }
        }
    }

    // -------- 3c. OI hard cap: total OI must not exceed max_tvl --------
    let new_total_oi = match params.perp_side {
        Side::Long => config.total_long_oi.saturating_add(notional_usd)
            .saturating_add(config.total_short_oi),
        Side::Short => config.total_long_oi
            .saturating_add(config.total_short_oi.saturating_add(notional_usd)),
    };
    ensure!(new_total_oi <= config.max_tvl, AtomicPerpsError::TVLCapExceeded);

    // -------- 3d. PSF health check — warn if balance < 5% of total collateral (F-02) --------
    let total_collateral_after = config.total_collateral.saturating_add(raw_collateral_usd);
    let min_psf = total_collateral_after / 20;
    if config.psf_balance < min_psf {
        crate::events::emit_psf_low(config.psf_balance, min_psf);
    }

    // -------- 4. Collateral: user -> collateral_vault --------
    spl_transfer(token_program, user_collateral_account, collateral_vault, user, params.collateral_amount)?;

    // -------- 5. Fee: vault -> fee_recipient (90%), PSF accrual (10%) --------
    let authority_bump = config.program_authority_bump;
    let authority_seeds: &[&[u8]] = &[AUTHORITY_SEED, &[authority_bump]];
    let signer_seeds: &[&[&[u8]]] = &[authority_seeds];

    let psf_portion_coll = fee_in_collateral / 10;
    let recipient_fee_coll = fee_in_collateral.saturating_sub(psf_portion_coll);
    if recipient_fee_coll > 0 {
        spl_transfer_signed(token_program, collateral_vault, fee_recipient_account, program_authority, recipient_fee_coll, signer_seeds)?;
    }
    // PSF accrual: track in USD equivalent (accounting only, no token transfer)
    let psf_usd = fee_usd / 10;
    config.psf_balance = config.psf_balance.saturating_add(psf_usd);

    // -------- 6. Create or reuse position account --------
    let now = Clock::get()?.unix_timestamp;
    let user_key = *user.key;
    let feed_key = *pyth_price_feed.key;
    let pos_seeds: &[&[u8]] = &[POSITION_SEED, user_key.as_ref(), feed_key.as_ref(), &[position_bump]];

    if position_ai.data_len() == 0 {
        create_pda_account(
            user,
            position_ai,
            system_program,
            8 + Position::INIT_SPACE,
            program_id,
            pos_seeds,
        )?;
    } else {
        let existing = load_position(position_ai)?;
        ensure!(!existing.is_open, AtomicPerpsError::BadInput);
    }

    let position = Position {
        owner: user_key,
        perp_market: *pyth_price_feed.key,
        collateral_mint: coll_mint,
        kamino_obligation: Pubkey::default(),
        collateral_amount: net_collateral,
        borrow_amount_usdc: notional_usd,  // REPURPOSED: stores notional size in USD 6dp
        perp_side: params.perp_side,
        perp_size: notional_usd,
        entry_price: sol_price_6dp,
        opened_at: now,
        hedge_amount: 0,
        collateral_entry_price: collateral_price_6dp,
        is_open: true,
        bump: position_bump,
    };

    // -------- 7. Post-state margin check --------
    // Margin ratio = collateral_usd / notional must be >= maintenance margin
    let post_collateral_usd = apply_haircut(
        token_to_usd(net_collateral, collateral_price_6dp, coll_decimals)?,
        haircut_bps,
    )?;
    let margin_ratio_bps = checked_mul_div(post_collateral_usd, BPS_DENOMINATOR, notional_usd)?;
    ensure!(margin_ratio_bps >= MAINTENANCE_MARGIN_BPS, AtomicPerpsError::PositionUnhealthy);

    save_position(position_ai, &position)?;

    // -------- 8. Update global accounting + OI --------
    match position.perp_side {
        Side::Long => {
            config.total_long_oi = config.total_long_oi.saturating_add(notional_usd);
        }
        Side::Short => {
            config.total_short_oi = config.total_short_oi.saturating_add(notional_usd);
        }
    }

    // Update collateral tracking
    config.total_collateral = config.total_collateral.saturating_add(raw_collateral_usd);
    if is_correlated {
        config.total_correlated_collateral = config.total_correlated_collateral.saturating_add(raw_collateral_usd);
    }

    save_config(global_config_ai, &config)?;

    emit_position_opened(
        &position.owner,
        position.collateral_amount,
        notional_usd,
        position.perp_side as u8,
        position.entry_price,
        params.leverage_bps,
    );

    Ok(())
}
