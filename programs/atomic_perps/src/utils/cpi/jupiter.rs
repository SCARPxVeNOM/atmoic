use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use crate::constants::JUPITER_PROGRAM_ID;
use crate::errors::AtomicPerpsError;
use crate::ensure;

pub fn cpi_swap<'info>(
    jupiter_program: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    instruction_data: &[u8],
) -> ProgramResult {
    ensure!(*jupiter_program.key == JUPITER_PROGRAM_ID, AtomicPerpsError::InvalidProgramId);
    ensure!(!instruction_data.is_empty(), AtomicPerpsError::BadInput);

    let metas: Vec<AccountMeta> = accounts
        .iter()
        .map(|a| {
            if a.is_writable {
                AccountMeta::new(*a.key, a.is_signer)
            } else {
                AccountMeta::new_readonly(*a.key, a.is_signer)
            }
        })
        .collect();

    let ix = Instruction {
        program_id: JUPITER_PROGRAM_ID,
        accounts: metas,
        data: instruction_data.to_vec(),
    };
    let mut all: Vec<AccountInfo<'info>> = Vec::with_capacity(accounts.len() + 1);
    all.push(jupiter_program.clone());
    all.extend_from_slice(accounts);
    invoke(&ix, &all)?;
    Ok(())
}
