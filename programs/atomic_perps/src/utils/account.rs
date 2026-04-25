use solana_program::{
    account_info::AccountInfo,
    entrypoint::ProgramResult,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    rent::Rent,
    system_instruction,
    sysvar::Sysvar,
};
use crate::errors::AtomicPerpsError;
use crate::ensure;
use crate::state::{GlobalConfig, Position};

pub const GLOBAL_CONFIG_DISCRIMINATOR: [u8; 8] = [0xA1, 0xA2, 0xA3, 0xA4, 0xA5, 0xA6, 0xA7, 0xA8];
pub const POSITION_DISCRIMINATOR: [u8; 8] = [0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7, 0xB8];
pub const ORDER_QUEUE_DISCRIMINATOR: [u8; 8] = [0xC1, 0xC2, 0xC3, 0xC4, 0xC5, 0xC6, 0xC7, 0xC8];
pub const COMMITMENT_DISCRIMINATOR: [u8; 8] = [0xD1, 0xD2, 0xD3, 0xD4, 0xD5, 0xD6, 0xD7, 0xD8];

pub fn load_config(ai: &AccountInfo) -> Result<GlobalConfig, ProgramError> {
    ensure!(ai.owner == &crate::ID, AtomicPerpsError::BadInput);
    let data = ai.try_borrow_data()?;
    ensure!(data.len() >= 8 + GlobalConfig::V1_SPACE, AtomicPerpsError::BadInput);
    ensure!(data[..8] == GLOBAL_CONFIG_DISCRIMINATOR, AtomicPerpsError::BadInput);
    GlobalConfig::deserialize(&data[8..]).ok_or(AtomicPerpsError::BadInput.into())
}

pub fn save_config(ai: &AccountInfo, cfg: &GlobalConfig) -> Result<(), ProgramError> {
    let mut data = ai.try_borrow_mut_data()?;
    data[..8].copy_from_slice(&GLOBAL_CONFIG_DISCRIMINATOR);
    cfg.serialize_into(&mut data[8..]);
    Ok(())
}

pub fn load_position(ai: &AccountInfo) -> Result<Position, ProgramError> {
    ensure!(ai.owner == &crate::ID, AtomicPerpsError::BadInput);
    let data = ai.try_borrow_data()?;
    ensure!(data.len() >= 8 + Position::INIT_SPACE, AtomicPerpsError::BadInput);
    ensure!(data[..8] == POSITION_DISCRIMINATOR, AtomicPerpsError::BadInput);
    Position::deserialize(&data[8..]).ok_or(AtomicPerpsError::BadInput.into())
}

pub fn save_position(ai: &AccountInfo, p: &Position) -> Result<(), ProgramError> {
    let mut data = ai.try_borrow_mut_data()?;
    data[..8].copy_from_slice(&POSITION_DISCRIMINATOR);
    p.serialize_into(&mut data[8..]);
    Ok(())
}

pub fn create_pda_account<'info>(
    payer: &AccountInfo<'info>,
    new_account: &AccountInfo<'info>,
    system_program: &AccountInfo<'info>,
    space: usize,
    owner: &Pubkey,
    signer_seeds: &[&[u8]],
) -> ProgramResult {
    let rent = Rent::get()?;
    let lamports = rent.minimum_balance(space);
    let ix = system_instruction::create_account(payer.key, new_account.key, lamports, space as u64, owner);
    invoke_signed(&ix, &[payer.clone(), new_account.clone(), system_program.clone()], &[signer_seeds])?;
    Ok(())
}
