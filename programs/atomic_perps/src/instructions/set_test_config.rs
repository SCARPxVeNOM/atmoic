/// Test-only instruction: seeds config OI and collateral tracking fields.
/// Compiled only when `mock-oracle` feature is active — never in production builds.
///
/// Allows tests to set total_long_oi, total_short_oi, total_collateral,
/// and total_correlated_collateral directly. This is necessary because:
/// - The vault skew check prevents opening a second position after the first
///   (skew = 100% with only one side of OI)
/// - JLP correlated cap (30%) requires existing SOL collateral in the system
/// - No production instruction can set these fields directly
///
/// Uses u64::MAX as sentinel for "no change" (same as update_config).
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

const NO_CHANGE: u64 = u64::MAX;

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    // Data: total_long_oi(8) + total_short_oi(8) + total_collateral(8) + total_correlated(8)
    if data.len() < 32 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let iter = &mut accounts.iter();
    let authority = next_account_info(iter)?;
    let global_config_ai = next_account_info(iter)?;

    ensure!(authority.is_signer, AtomicPerpsError::Unauthorized);

    let (config_pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    ensure!(*global_config_ai.key == config_pda, AtomicPerpsError::BadInput);

    let mut config = load_config(global_config_ai)?;
    ensure!(*authority.key == config.authority, AtomicPerpsError::Unauthorized);

    let total_long_oi = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let total_short_oi = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let total_collateral = u64::from_le_bytes(data[16..24].try_into().unwrap());
    let total_correlated = u64::from_le_bytes(data[24..32].try_into().unwrap());

    if total_long_oi != NO_CHANGE { config.total_long_oi = total_long_oi; }
    if total_short_oi != NO_CHANGE { config.total_short_oi = total_short_oi; }
    if total_collateral != NO_CHANGE { config.total_collateral = total_collateral; }
    if total_correlated != NO_CHANGE { config.total_correlated_collateral = total_correlated; }

    save_config(global_config_ai, &config)?;
    Ok(())
}
