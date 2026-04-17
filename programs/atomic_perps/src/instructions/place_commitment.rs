use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::Sysvar,
};
use crate::errors::AtomicPerpsError;
use crate::constants::POSITION_SEED;
use crate::ensure;
use crate::state::OrderCommitment;
use crate::utils::account::{create_pda_account, COMMITMENT_DISCRIMINATOR};

const COMMITMENT_SEED: &[u8] = b"commitment";

/// Place a commit hash for a large order (>$10K notional).
/// Data: hash(32) + side(1) + notional_estimate(8) = 41 bytes
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 41 { return Err(ProgramError::InvalidInstructionData); }

    let iter = &mut accounts.iter();
    let user = next_account_info(iter)?;
    let commitment_ai = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    ensure!(user.is_signer, AtomicPerpsError::Unauthorized);

    // Verify commitment PDA
    let (commitment_pda, bump) = Pubkey::find_program_address(
        &[COMMITMENT_SEED, user.key.as_ref()], program_id,
    );
    ensure!(*commitment_ai.key == commitment_pda, AtomicPerpsError::BadInput);

    let mut hash = [0u8; 32];
    hash.copy_from_slice(&data[0..32]);
    let side = data[32];
    let notional = u64::from_le_bytes(data[33..41].try_into().unwrap());
    let slot = Clock::get()?.slot;

    // Create or overwrite commitment PDA
    if commitment_ai.data_len() == 0 {
        let space = 8 + OrderCommitment::INIT_SPACE;
        let seeds: &[&[u8]] = &[COMMITMENT_SEED, user.key.as_ref(), &[bump]];
        create_pda_account(user, commitment_ai, system_program, space, program_id, seeds)?;
    }

    let commitment = OrderCommitment { hash, side, notional, slot, revealed: false };
    let mut buf = commitment_ai.try_borrow_mut_data()?;
    buf[..8].copy_from_slice(&COMMITMENT_DISCRIMINATOR);
    commitment.serialize_into(&mut buf[8..]);

    Ok(())
}
