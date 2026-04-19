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

/// Migration: extends GlobalConfig account to latest layout.
/// V2: adds OI + PSF fields (24 bytes).
/// V3: adds multi-collateral fields (177 bytes) — requires 5 Pubkeys in instruction data.
///
/// Idempotent for realloc. If data provides V3 pubkeys, they are always written
/// (allows updating vault addresses without re-deploying).
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let global_config_ai = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    ensure!(authority.is_signer, AtomicPerpsError::Unauthorized);

    let (config_pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    ensure!(*global_config_ai.key == config_pda, AtomicPerpsError::BadInput);

    let mut config = load_config(global_config_ai)?;
    ensure!(*authority.key == config.authority, AtomicPerpsError::Unauthorized);

    let target = 8 + GlobalConfig::INIT_SPACE;

    // Realloc if needed
    if global_config_ai.data_len() < target {
        let diff = Rent::get()?.minimum_balance(target).saturating_sub(global_config_ai.lamports());
        if diff > 0 {
            invoke(
                &system_instruction::transfer(authority.key, global_config_ai.key, diff),
                &[authority.clone(), global_config_ai.clone(), system_program.clone()],
            )?;
        }
        global_config_ai.realloc(target, false)?;
    }

    // V3 init data: 5 Pubkeys = 160 bytes (jlp_mint, jlp_vault, msol_mint, msol_vault, pyth_msol_feed)
    if data.len() >= 160 {
        let mut o = 0;
        let pk = |d: &[u8], o: &mut usize| -> Pubkey {
            let p = Pubkey::new_from_array(d[*o..*o+32].try_into().unwrap());
            *o += 32; p
        };
        config.jlp_mint = pk(data, &mut o);
        config.jlp_vault = pk(data, &mut o);
        config.msol_mint = pk(data, &mut o);
        config.msol_vault = pk(data, &mut o);
        config.pyth_msol_feed = pk(data, &mut o);
        // Initialize tracking fields to zero on first migration
        if config.total_collateral == 0 && config.total_correlated_collateral == 0 {
            config.stress_active = false;
        }
    }

    save_config(global_config_ai, &config)?;
    Ok(())
}
