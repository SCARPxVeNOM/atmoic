use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    pubkey::Pubkey,
};
use crate::errors::AtomicPerpsError;
use crate::ensure;
use crate::state::{Order, MAX_ORDERS_PER_SHARD, ORDER_QUEUE_HEADER};
use crate::utils::account::{create_pda_account, ORDER_QUEUE_DISCRIMINATOR};

const QUEUE_SEED: &[u8] = b"queue";

/// Initialize a queue shard PDA.
/// Data: market(1) + side(1) + shard(1) = 3 bytes
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 3 { return Err(solana_program::program_error::ProgramError::InvalidInstructionData); }

    let market = data[0];
    let side = data[1];
    let shard = data[2];

    let iter = &mut accounts.iter();
    let payer = next_account_info(iter)?;
    let queue_shard_ai = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;

    ensure!(payer.is_signer, AtomicPerpsError::Unauthorized);
    ensure!(*system_program.key == solana_program::system_program::ID, AtomicPerpsError::BadInput);

    // Derive expected PDA
    let seeds_data = [market, side, shard];
    let (expected_pda, bump) = Pubkey::find_program_address(
        &[QUEUE_SEED, &seeds_data],
        program_id,
    );
    ensure!(*queue_shard_ai.key == expected_pda, AtomicPerpsError::BadInput);

    // Account size: discriminator(8) + header(4) + max_orders * order_size
    let space = 8 + ORDER_QUEUE_HEADER + MAX_ORDERS_PER_SHARD * Order::SIZE;

    let signer_seeds: &[&[u8]] = &[QUEUE_SEED, &seeds_data, &[bump]];
    create_pda_account(
        payer,
        queue_shard_ai,
        system_program,
        space,
        program_id,
        signer_seeds,
    )?;

    // Write discriminator + zero count
    let mut qdata = queue_shard_ai.try_borrow_mut_data()?;
    qdata[..8].copy_from_slice(&ORDER_QUEUE_DISCRIMINATOR);
    qdata[8..12].copy_from_slice(&0u32.to_le_bytes());

    Ok(())
}
