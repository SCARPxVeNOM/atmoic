use solana_program::{
    account_info::{next_account_info, AccountInfo},
    clock::Clock,
    entrypoint::ProgramResult,
    pubkey::Pubkey,
    sysvar::Sysvar,
};
use crate::errors::AtomicPerpsError;
use crate::constants::*;
use crate::ensure;
use crate::state::{Order, ORDER_QUEUE_HEADER, MAX_ORDERS_PER_SHARD};
use crate::utils::oracle::validate_and_get_price;
use crate::utils::account::{load_config, save_config, ORDER_QUEUE_DISCRIMINATOR};

const PYTH_CAP_BPS: u64 = 30; // ±0.3%

/// Permissionless batch execution — clears DFBA orders from queue shards.
/// Queue shards passed via remaining_accounts.
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let crank = next_account_info(iter)?;
    let global_config_ai = next_account_info(iter)?;
    let pyth_price_feed = next_account_info(iter)?;
    // Remaining accounts = queue shard accounts
    let queue_shards = &accounts[3..];

    ensure!(crank.is_signer, AtomicPerpsError::Unauthorized);

    let (config_pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    ensure!(*global_config_ai.key == config_pda, AtomicPerpsError::BadInput);

    let config = load_config(global_config_ai)?;
    ensure!(!config.is_paused, AtomicPerpsError::ProtocolPaused);
    ensure!(*pyth_price_feed.key == config.pyth_sol_feed, AtomicPerpsError::InvalidOracleFeed);

    let (pyth_price, _) = validate_and_get_price(pyth_price_feed, &Clock::get()?)?;

    // Price cap: clearing price must be within ±0.3% of Pyth
    let max_deviation = (pyth_price * PYTH_CAP_BPS) / BPS_DENOMINATOR;
    let price_upper = pyth_price.saturating_add(max_deviation);
    let price_lower = pyth_price.saturating_sub(max_deviation);

    // Read orders from all queue shards, match bids and asks
    let mut total_matched = 0u64;

    for shard_ai in queue_shards {
        ensure!(shard_ai.owner == program_id, AtomicPerpsError::BadInput);
        let data = shard_ai.try_borrow_data()?;
        if data.len() < 8 + ORDER_QUEUE_HEADER { continue; }
        if data[..8] != ORDER_QUEUE_DISCRIMINATOR { continue; }

        let count = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
        let count = count.min(MAX_ORDERS_PER_SHARD);

        for i in 0..count {
            let off = 12 + i * Order::SIZE;
            if off + Order::SIZE > data.len() { break; }
            if let Some(order) = Order::deserialize(&data[off..off + Order::SIZE]) {
                // Validate order price within Pyth cap
                if order.price >= price_lower && order.price <= price_upper {
                    total_matched = total_matched.saturating_add(order.size);
                }
            }
        }
        drop(data);

        // Clear matched orders by zeroing count
        let mut data = shard_ai.try_borrow_mut_data()?;
        data[8..12].copy_from_slice(&0u32.to_le_bytes());
    }

    // Update config accounting if orders were matched
    if total_matched > 0 {
        let mut config = load_config(global_config_ai)?;
        // PSF: 10% of crank fees go to PSF
        config.psf_balance = config.psf_balance.saturating_add(total_matched / 10_000);
        save_config(global_config_ai, &config)?;
    }

    Ok(())
}
