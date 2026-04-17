use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::Sysvar,
};
use crate::errors::AtomicPerpsError;
use crate::ensure;
use crate::state::{Order, ORDER_QUEUE_HEADER, MAX_ORDERS_PER_SHARD};
use crate::utils::account::ORDER_QUEUE_DISCRIMINATOR;

/// Place an order directly into a queue shard.
/// Data: price(8) + size(8) = 16 bytes
pub fn process(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 16 { return Err(ProgramError::InvalidInstructionData); }

    let iter = &mut accounts.iter();
    let user = next_account_info(iter)?;
    let queue_shard_ai = next_account_info(iter)?;

    ensure!(user.is_signer, AtomicPerpsError::Unauthorized);
    ensure!(queue_shard_ai.owner == &crate::ID, AtomicPerpsError::BadInput);

    let price = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let size = u64::from_le_bytes(data[8..16].try_into().unwrap());

    let mut qdata = queue_shard_ai.try_borrow_mut_data()?;
    ensure!(qdata.len() >= 8 + ORDER_QUEUE_HEADER, AtomicPerpsError::BadInput);
    ensure!(qdata[..8] == ORDER_QUEUE_DISCRIMINATOR, AtomicPerpsError::BadInput);

    let count = u32::from_le_bytes(qdata[8..12].try_into().unwrap()) as usize;
    ensure!(count < MAX_ORDERS_PER_SHARD, AtomicPerpsError::QueueFull);

    let order = Order {
        user: *user.key,
        price,
        size,
        timestamp: Clock::get()?.unix_timestamp,
    };
    let off = 12 + count * Order::SIZE;
    order.serialize_into(&mut qdata[off..off + Order::SIZE]);
    qdata[8..12].copy_from_slice(&((count + 1) as u32).to_le_bytes());

    Ok(())
}
