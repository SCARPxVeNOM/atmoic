use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint::ProgramResult,
    pubkey::Pubkey,
};
use crate::errors::AtomicPerpsError;
use crate::ensure;
use crate::state::{Order, ORDER_QUEUE_HEADER, MAX_ORDERS_PER_SHARD};
use crate::utils::account::ORDER_QUEUE_DISCRIMINATOR;

/// Cancel an order from a queue shard. Only the order owner can cancel.
pub fn process(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let user = next_account_info(iter)?;
    let queue_shard_ai = next_account_info(iter)?;

    ensure!(user.is_signer, AtomicPerpsError::Unauthorized);
    ensure!(queue_shard_ai.owner == &crate::ID, AtomicPerpsError::BadInput);

    let mut qdata = queue_shard_ai.try_borrow_mut_data()?;
    ensure!(qdata.len() >= 8 + ORDER_QUEUE_HEADER, AtomicPerpsError::BadInput);
    ensure!(qdata[..8] == ORDER_QUEUE_DISCRIMINATOR, AtomicPerpsError::BadInput);

    let count = u32::from_le_bytes(qdata[8..12].try_into().unwrap()) as usize;
    let count = count.min(MAX_ORDERS_PER_SHARD);

    // Find and remove the user's order (swap with last)
    let mut found = false;
    for i in 0..count {
        let off = 12 + i * Order::SIZE;
        if off + 32 > qdata.len() { break; }
        let order_user = Pubkey::new_from_array(qdata[off..off + 32].try_into().unwrap());
        if order_user == *user.key {
            // Swap with last order
            if i < count - 1 {
                let last_off = 12 + (count - 1) * Order::SIZE;
                let last_bytes: Vec<u8> = qdata[last_off..last_off + Order::SIZE].to_vec();
                qdata[off..off + Order::SIZE].copy_from_slice(&last_bytes);
            }
            // Zero the last slot and decrement count
            let last_off = 12 + (count - 1) * Order::SIZE;
            for b in &mut qdata[last_off..last_off + Order::SIZE] { *b = 0; }
            qdata[8..12].copy_from_slice(&((count - 1) as u32).to_le_bytes());
            found = true;
            break;
        }
    }

    ensure!(found, AtomicPerpsError::OrderNotFound);
    Ok(())
}
