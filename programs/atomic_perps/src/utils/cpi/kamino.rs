use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::invoke,
};
use crate::constants::KAMINO_LENDING_PROGRAM_ID;
use crate::errors::AtomicPerpsError;
use crate::ensure;

fn validate_kamino(program: &AccountInfo) -> ProgramResult {
    ensure!(*program.key == KAMINO_LENDING_PROGRAM_ID, AtomicPerpsError::InvalidProgramId);
    Ok(())
}

fn build_metas(accounts: &[AccountInfo]) -> Vec<AccountMeta> {
    accounts
        .iter()
        .map(|a| {
            if a.is_writable {
                AccountMeta::new(*a.key, a.is_signer)
            } else {
                AccountMeta::new_readonly(*a.key, a.is_signer)
            }
        })
        .collect()
}

fn invoke_passthrough<'info>(
    program: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    data: &[u8],
) -> ProgramResult {
    validate_kamino(program)?;
    ensure!(!data.is_empty(), AtomicPerpsError::BadInput);
    let ix = Instruction {
        program_id: KAMINO_LENDING_PROGRAM_ID,
        accounts: build_metas(accounts),
        data: data.to_vec(),
    };
    let mut all: Vec<AccountInfo<'info>> = Vec::with_capacity(accounts.len() + 1);
    all.push(program.clone());
    all.extend_from_slice(accounts);
    invoke(&ix, &all)?;
    Ok(())
}

pub fn cpi_borrow<'info>(
    program: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    data: &[u8],
) -> ProgramResult {
    invoke_passthrough(program, accounts, data)
}

pub fn cpi_repay<'info>(
    program: &AccountInfo<'info>,
    accounts: &[AccountInfo<'info>],
    data: &[u8],
) -> ProgramResult {
    invoke_passthrough(program, accounts, data)
}
