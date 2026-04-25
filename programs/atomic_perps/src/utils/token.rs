use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    instruction::{AccountMeta, Instruction},
    program::{invoke, invoke_signed},
    program_error::ProgramError,
    pubkey::Pubkey,
};
use crate::constants::SPL_TOKEN_PROGRAM_ID;
use crate::errors::AtomicPerpsError;
use crate::ensure;

pub fn spl_transfer<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
) -> ProgramResult {
    ensure!(*token_program.key == SPL_TOKEN_PROGRAM_ID, AtomicPerpsError::InvalidProgramId);
    let ix = build_transfer_ix(from.key, to.key, authority.key, amount);
    invoke(&ix, &[from.clone(), to.clone(), authority.clone()])?;
    Ok(())
}

pub fn spl_transfer_signed<'info>(
    token_program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer_seeds: &[&[&[u8]]],
) -> ProgramResult {
    ensure!(*token_program.key == SPL_TOKEN_PROGRAM_ID, AtomicPerpsError::InvalidProgramId);
    let ix = build_transfer_ix(from.key, to.key, authority.key, amount);
    invoke_signed(&ix, &[from.clone(), to.clone(), authority.clone()], signer_seeds)?;
    Ok(())
}

fn build_transfer_ix(from: &Pubkey, to: &Pubkey, authority: &Pubkey, amount: u64) -> Instruction {
    let mut data = [0u8; 9];
    data[0] = 3;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    Instruction {
        program_id: SPL_TOKEN_PROGRAM_ID,
        accounts: vec![
            AccountMeta::new(*from, false),
            AccountMeta::new(*to, false),
            AccountMeta::new_readonly(*authority, true),
        ],
        data: data.to_vec(),
    }
}

pub fn read_token_amount(ai: &AccountInfo) -> Result<u64, ProgramError> {
    ensure!(ai.owner == &SPL_TOKEN_PROGRAM_ID, AtomicPerpsError::InvalidProgramId);
    let data = ai.try_borrow_data()?;
    ensure!(data.len() >= 72, AtomicPerpsError::InvalidCollateralMint);
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

pub fn read_token_mint(ai: &AccountInfo) -> Result<Pubkey, ProgramError> {
    ensure!(ai.owner == &SPL_TOKEN_PROGRAM_ID, AtomicPerpsError::InvalidProgramId);
    let data = ai.try_borrow_data()?;
    ensure!(data.len() >= 32, AtomicPerpsError::InvalidCollateralMint);
    Ok(Pubkey::new_from_array(data[0..32].try_into().unwrap()))
}

pub fn read_token_owner(ai: &AccountInfo) -> Result<Pubkey, ProgramError> {
    ensure!(ai.owner == &SPL_TOKEN_PROGRAM_ID, AtomicPerpsError::InvalidProgramId);
    let data = ai.try_borrow_data()?;
    ensure!(data.len() >= 64, AtomicPerpsError::InvalidCollateralMint);
    Ok(Pubkey::new_from_array(data[32..64].try_into().unwrap()))
}
