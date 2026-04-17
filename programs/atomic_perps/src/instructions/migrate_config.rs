use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::invoke,
    pubkey::Pubkey,
    system_instruction,
    rent::Rent,
    sysvar::Sysvar,
};
use crate::errors::AtomicPerpsError;
use crate::constants::CONFIG_SEED;
use crate::ensure;
use crate::state::GlobalConfig;
use crate::utils::account::{load_config, save_config};

/// One-shot migration: extends GlobalConfig account to v2 layout (adds OI + PSF fields).
/// Idempotent — returns Ok if already migrated.
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let global_config_ai = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    ensure!(authority.is_signer, AtomicPerpsError::Unauthorized);

    let (config_pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    ensure!(*global_config_ai.key == config_pda, AtomicPerpsError::BadInput);

    let config = load_config(global_config_ai)?;
    ensure!(*authority.key == config.authority, AtomicPerpsError::Unauthorized);

    let target = 8 + GlobalConfig::INIT_SPACE;
    if global_config_ai.data_len() >= target { return Ok(()); }

    let diff = Rent::get()?.minimum_balance(target).saturating_sub(global_config_ai.lamports());
    if diff > 0 {
        invoke(
            &system_instruction::transfer(authority.key, global_config_ai.key, diff),
            &[authority.clone(), global_config_ai.clone(), system_program.clone()],
        )?;
    }
    global_config_ai.realloc(target, false)?;
    save_config(global_config_ai, &config)?;
    Ok(())
}
