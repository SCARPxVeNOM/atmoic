use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};
use crate::state::GlobalConfig;
use crate::errors::AtomicPerpsError;
use crate::constants::{CONFIG_SEED, AUTHORITY_SEED};
use crate::ensure;
use crate::utils::account::{create_pda_account, save_config};
use crate::utils::token::{read_token_mint, read_token_owner, read_token_amount};
use crate::events::emit_config_initialized;

pub struct InitializeParams {
    pub fee_recipient: Pubkey,
    pub pyth_sol_feed: Pubkey,
    pub sol_mint: Pubkey,
    pub usdc_mint: Pubkey,
    pub max_leverage: u64,
    pub liquidation_threshold: u64,
    pub protocol_fee_bps: u64,
    pub max_tvl: u64,
}

impl InitializeParams {
    // 4*32 + 4*8 = 160 bytes
    fn deserialize(data: &[u8]) -> Option<Self> {
        if data.len() < 160 { return None; }
        let mut o = 0;
        let pk = |d: &[u8], o: &mut usize| -> Pubkey {
            let p = Pubkey::new_from_array(d[*o..*o+32].try_into().unwrap()); *o += 32; p
        };
        let u = |d: &[u8], o: &mut usize| -> u64 {
            let v = u64::from_le_bytes(d[*o..*o+8].try_into().unwrap()); *o += 8; v
        };
        Some(Self {
            fee_recipient: pk(data, &mut o), pyth_sol_feed: pk(data, &mut o),
            sol_mint: pk(data, &mut o), usdc_mint: pk(data, &mut o),
            max_leverage: u(data, &mut o), liquidation_threshold: u(data, &mut o),
            protocol_fee_bps: u(data, &mut o), max_tvl: u(data, &mut o),
        })
    }
}

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let params = InitializeParams::deserialize(data)
        .ok_or(ProgramError::InvalidInstructionData)?;

    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let global_config = next_account_info(iter)?;
    let program_authority = next_account_info(iter)?;
    let sol_vault = next_account_info(iter)?;
    let usdc_reserve = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    ensure!(authority.is_signer, AtomicPerpsError::Unauthorized);
    ensure!(*system_program.key == solana_program::system_program::ID, AtomicPerpsError::BadInput);

    // Verify PDAs
    let (config_pda, config_bump) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    ensure!(*global_config.key == config_pda, AtomicPerpsError::BadInput);

    let (auth_pda, auth_bump) = Pubkey::find_program_address(&[AUTHORITY_SEED], program_id);
    ensure!(*program_authority.key == auth_pda, AtomicPerpsError::BadInput);

    let auth_key = *program_authority.key;

    ensure!(
        read_token_mint(sol_vault)? == params.sol_mint,
        AtomicPerpsError::InvalidCollateralMint
    );
    ensure!(
        read_token_owner(sol_vault)? == auth_key,
        AtomicPerpsError::Unauthorized
    );
    ensure!(
        read_token_mint(usdc_reserve)? == params.usdc_mint,
        AtomicPerpsError::InvalidCollateralMint
    );
    ensure!(
        read_token_owner(usdc_reserve)? == auth_key,
        AtomicPerpsError::Unauthorized
    );

    let reserve_amount = read_token_amount(usdc_reserve)?;

    let space = 8 + GlobalConfig::INIT_SPACE;
    let seeds: &[&[u8]] = &[CONFIG_SEED, &[config_bump]];
    create_pda_account(
        authority,
        global_config,
        system_program,
        space,
        program_id,
        seeds,
    )?;

    let cfg = GlobalConfig {
        authority: *authority.key,
        fee_recipient: params.fee_recipient,
        pyth_sol_feed: params.pyth_sol_feed,
        sol_mint: params.sol_mint,
        usdc_mint: params.usdc_mint,
        sol_vault: *sol_vault.key,
        usdc_reserve: *usdc_reserve.key,
        is_paused: false,
        max_leverage: params.max_leverage,
        liquidation_threshold: params.liquidation_threshold,
        protocol_fee_bps: params.protocol_fee_bps,
        max_tvl: params.max_tvl,
        total_usdc_borrowed: 0,
        total_usdc_reserve: reserve_amount,
        bump: config_bump,
        program_authority_bump: auth_bump,
        total_long_oi: 0,
        total_short_oi: 0,
        psf_balance: 0,
        jlp_mint: Pubkey::default(),
        jlp_vault: Pubkey::default(),
        msol_mint: Pubkey::default(),
        msol_vault: Pubkey::default(),
        pyth_msol_feed: Pubkey::default(),
        stress_active: false,
        total_correlated_collateral: 0,
        total_collateral: 0,
        last_funding_at: 0,
        accumulated_funding: 0,
    };
    save_config(global_config, &cfg)?;

    emit_config_initialized(
        &cfg.authority,
        cfg.max_leverage,
        cfg.liquidation_threshold,
        cfg.protocol_fee_bps,
        cfg.max_tvl,
    );

    Ok(())
}
