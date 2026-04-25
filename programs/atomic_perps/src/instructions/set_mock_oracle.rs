/// Test-only instruction: writes price + confidence into a program-owned oracle account.
/// Compiled only when `mock-oracle` feature is active — never in production builds.
use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    program::invoke,
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
    sysvar::{rent::Rent, Sysvar},
};

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 16 {
        return Err(ProgramError::InvalidInstructionData);
    }

    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let oracle = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    // Create oracle account if it doesn't exist yet
    if oracle.data_len() == 0 {
        let space: usize = 16;
        let rent = Rent::get()?;
        let lamports = rent.minimum_balance(space);
        let ix = system_instruction::create_account(
            payer.key,
            oracle.key,
            lamports,
            space as u64,
            program_id,
        );
        invoke(&ix, &[payer.clone(), oracle.clone(), system_program.clone()])?;
    }

    // Write price (bytes 0..8) and confidence (bytes 8..16)
    let mut oracle_data = oracle.try_borrow_mut_data()?;
    oracle_data[0..8].copy_from_slice(&data[0..8]);
    oracle_data[8..16].copy_from_slice(&data[8..16]);

    Ok(())
}
