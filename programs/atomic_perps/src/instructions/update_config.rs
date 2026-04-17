use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
};
use crate::errors::AtomicPerpsError;
use crate::constants::CONFIG_SEED;
use crate::ensure;
use crate::utils::account::{load_config, save_config};

const NO_CHANGE_U64: u64 = u64::MAX;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // Data layout: new_authority(32) + new_fee_recipient(32) + protocol_fee_bps(8)
    //   + max_leverage(8) + liquidation_threshold(8) + max_tvl(8) + is_paused(1)
    //   + [optional] total_usdc_reserve(8)
    // Total: 97 bytes minimum, 105 with optional reserve field.
    // Use Pubkey::default() = no change, u64::MAX = no change, 255 = no change
    if data.len() < 97 { return Err(ProgramError::InvalidInstructionData); }

    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let global_config_ai = next_account_info(iter)?;

    ensure!(authority.is_signer, AtomicPerpsError::Unauthorized);

    let (config_pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    ensure!(*global_config_ai.key == config_pda, AtomicPerpsError::BadInput);

    let mut config = load_config(global_config_ai)?;
    ensure!(*authority.key == config.authority, AtomicPerpsError::Unauthorized);

    let mut o = 0;
    let new_authority = Pubkey::new_from_array(data[o..o+32].try_into().unwrap()); o += 32;
    let new_fee_recipient = Pubkey::new_from_array(data[o..o+32].try_into().unwrap()); o += 32;
    let new_fee_bps = u64::from_le_bytes(data[o..o+8].try_into().unwrap()); o += 8;
    let new_leverage = u64::from_le_bytes(data[o..o+8].try_into().unwrap()); o += 8;
    let new_liq_threshold = u64::from_le_bytes(data[o..o+8].try_into().unwrap()); o += 8;
    let new_max_tvl = u64::from_le_bytes(data[o..o+8].try_into().unwrap()); o += 8;
    let new_paused = data[o];

    if new_authority != Pubkey::default() { config.authority = new_authority; }
    if new_fee_recipient != Pubkey::default() { config.fee_recipient = new_fee_recipient; }
    if new_fee_bps != NO_CHANGE_U64 { config.protocol_fee_bps = new_fee_bps; }
    if new_leverage != NO_CHANGE_U64 { config.max_leverage = new_leverage; }
    if new_liq_threshold != NO_CHANGE_U64 { config.liquidation_threshold = new_liq_threshold; }
    if new_max_tvl != NO_CHANGE_U64 { config.max_tvl = new_max_tvl; }
    if new_paused != 255 { config.is_paused = new_paused != 0; }

    // Optional: total_usdc_reserve (backward-compatible — only present if data is long enough)
    if data.len() >= 105 {
        let new_reserve = u64::from_le_bytes(data[97..105].try_into().unwrap());
        if new_reserve != NO_CHANGE_U64 { config.total_usdc_reserve = new_reserve; }
    }

    // Optional: psf_balance (V2 field — only present if data is long enough)
    if data.len() >= 113 {
        let new_psf = u64::from_le_bytes(data[105..113].try_into().unwrap());
        if new_psf != NO_CHANGE_U64 { config.psf_balance = new_psf; }
    }

    save_config(global_config_ai, &config)?;
    Ok(())
}
