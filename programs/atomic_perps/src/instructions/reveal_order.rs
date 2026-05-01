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
use crate::state::{Order, OrderCommitment, ORDER_QUEUE_HEADER, MAX_ORDERS_PER_SHARD};
use crate::utils::account::{COMMITMENT_DISCRIMINATOR, ORDER_QUEUE_DISCRIMINATOR};

const COMMITMENT_SEED: &[u8] = b"commitment";

/// Reveal a committed order — validates hash matches, places into queue shard.
/// Data: price(8) + size(8) + nonce(32) = 48 bytes
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    if data.len() < 48 { return Err(ProgramError::InvalidInstructionData); }

    let iter = &mut accounts.iter();
    let user = next_account_info(iter)?;
    let commitment_ai = next_account_info(iter)?;
    let queue_shard_ai = next_account_info(iter)?;

    ensure!(user.is_signer, AtomicPerpsError::Unauthorized);

    let (commitment_pda, _) = Pubkey::find_program_address(
        &[COMMITMENT_SEED, user.key.as_ref()], program_id,
    );
    ensure!(*commitment_ai.key == commitment_pda, AtomicPerpsError::BadInput);
    ensure!(queue_shard_ai.owner == program_id, AtomicPerpsError::BadInput);

    // Load commitment (verify ownership before deserialization)
    ensure!(commitment_ai.owner == program_id, AtomicPerpsError::BadInput);
    let cdata = commitment_ai.try_borrow_data()?;
    ensure!(cdata.len() >= 8 + OrderCommitment::INIT_SPACE, AtomicPerpsError::CommitmentNotFound);
    ensure!(cdata[..8] == COMMITMENT_DISCRIMINATOR, AtomicPerpsError::CommitmentNotFound);
    let commitment = OrderCommitment::deserialize(&cdata[8..])
        .ok_or(AtomicPerpsError::CommitmentNotFound)?;
    ensure!(!commitment.revealed, AtomicPerpsError::CommitmentAlreadyRevealed);
    drop(cdata);

    // Parse reveal data
    let price = u64::from_le_bytes(data[0..8].try_into().unwrap());
    let size = u64::from_le_bytes(data[8..16].try_into().unwrap());
    let nonce = &data[16..48];

    // Verify hash: sha256(user + price + size + side + nonce)
    let mut hash_input = Vec::with_capacity(32 + 8 + 8 + 1 + 32);
    hash_input.extend_from_slice(user.key.as_ref());
    hash_input.extend_from_slice(&price.to_le_bytes());
    hash_input.extend_from_slice(&size.to_le_bytes());
    hash_input.push(commitment.side);
    hash_input.extend_from_slice(nonce);
    let computed = solana_program::hash::hash(&hash_input);
    ensure!(computed.to_bytes()[..32] == commitment.hash, AtomicPerpsError::HashMismatch);

    // Mark as revealed
    let mut cdata = commitment_ai.try_borrow_mut_data()?;
    cdata[8 + 49] = 1; // revealed = true
    drop(cdata);

    // Place order into queue shard
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
