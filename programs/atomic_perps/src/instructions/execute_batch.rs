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
use crate::events::{emit_batch_cleared, emit_dfba_fill};

const PYTH_CAP_BPS: u64 = 30; // ±0.3%

/// Lightweight order entry for sorting — avoids copying full 56-byte Order.
#[derive(Clone, Copy)]
struct OrderEntry {
    price: u64,
    size: u64,
    shard_idx: u8,
    order_idx: u8,
}

/// Find the uniform clearing price that maximizes matched volume.
/// Bids sorted descending, asks sorted ascending.
fn find_clearing_price(bids: &[OrderEntry], asks: &[OrderEntry]) -> (u64, u64) {
    if bids.is_empty() || asks.is_empty() {
        return (0, 0);
    }

    // Best bid must be >= best ask for any match
    if bids[0].price < asks[0].price {
        return (0, 0);
    }

    // Pre-compute cumulative ask volumes (ascending by price)
    // cum_ask_vol[i] = total ask volume for asks[0..=i]
    let mut cum_ask: Vec<u64> = Vec::with_capacity(asks.len());
    let mut running = 0u64;
    for a in asks {
        running = running.saturating_add(a.size);
        cum_ask.push(running);
    }

    let mut best_price: u64 = 0;
    let mut best_volume: u64 = 0;
    let mut cum_bid_vol: u64 = 0;
    let mut ask_ptr: usize = 0;

    // Walk bid prices descending as candidate clearing prices
    for bid in bids {
        cum_bid_vol = cum_bid_vol.saturating_add(bid.size);

        // Advance ask pointer: include all asks with price <= bid.price
        while ask_ptr < asks.len() && asks[ask_ptr].price <= bid.price {
            ask_ptr += 1;
        }

        if ask_ptr == 0 {
            continue; // No asks at or below this bid price
        }

        let cum_ask_vol = cum_ask[ask_ptr - 1];
        let matched = cum_bid_vol.min(cum_ask_vol);
        if matched > best_volume {
            best_volume = matched;
            best_price = bid.price;
        }
    }

    // Also check ask prices as candidates (clearing price may sit at an ask level)
    cum_bid_vol = 0;
    let mut bid_ptr: usize = 0;
    for (i, ask) in asks.iter().enumerate() {
        // Advance bid pointer: include all bids with price >= ask.price
        while bid_ptr < bids.len() && bids[bid_ptr].price >= ask.price {
            cum_bid_vol = cum_bid_vol.saturating_add(bids[bid_ptr].size);
            bid_ptr += 1;
        }

        let cum_ask_vol = cum_ask[i];
        let matched = cum_bid_vol.min(cum_ask_vol);
        if matched > best_volume {
            best_volume = matched;
            best_price = ask.price;
        }
    }

    (best_price, best_volume)
}

/// Permissionless batch execution — matches DFBA bids and asks on-chain.
/// Data: num_bid_shards(1). Queue shards via remaining_accounts: first N = bids, rest = asks.
pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let iter = &mut accounts.iter();
    let crank = next_account_info(iter)?;
    let global_config_ai = next_account_info(iter)?;
    let pyth_price_feed = next_account_info(iter)?;
    let queue_shards = &accounts[3..];

    ensure!(crank.is_signer, AtomicPerpsError::Unauthorized);

    let (config_pda, _) = Pubkey::find_program_address(&[CONFIG_SEED], program_id);
    ensure!(*global_config_ai.key == config_pda, AtomicPerpsError::BadInput);

    let config = load_config(global_config_ai)?;
    ensure!(!config.is_paused, AtomicPerpsError::ProtocolPaused);

    let (pyth_price, _) = validate_and_get_price(pyth_price_feed, &Clock::get()?)?;

    // Price cap: clearing price must be within ±0.3% of Pyth
    let max_deviation = (pyth_price * PYTH_CAP_BPS) / BPS_DENOMINATOR;
    let price_upper = pyth_price.saturating_add(max_deviation);
    let price_lower = pyth_price.saturating_sub(max_deviation);

    // Ensure we have shards (at least 2 — at least one bid + one ask)
    ensure!(queue_shards.len() >= 2, AtomicPerpsError::BadInput);

    // Read bid/ask split from instruction data (default: half and half)
    let num_bid_shards = if !data.is_empty() {
        (data[0] as usize).min(queue_shards.len())
    } else {
        queue_shards.len() / 2
    };
    let num_ask_shards = queue_shards.len() - num_bid_shards;
    ensure!(num_bid_shards > 0 && num_ask_shards > 0, AtomicPerpsError::BadInput);

    let bid_shards = &queue_shards[..num_bid_shards];
    let ask_shards = &queue_shards[num_bid_shards..];

    // ---- Phase 1: Collect valid orders ----
    let mut bids: Vec<OrderEntry> = Vec::with_capacity(MAX_ORDERS_PER_SHARD * num_bid_shards);
    let mut asks: Vec<OrderEntry> = Vec::with_capacity(MAX_ORDERS_PER_SHARD * num_ask_shards);

    for (shard_idx, shard_ai) in bid_shards.iter().enumerate() {
        ensure!(shard_ai.owner == program_id, AtomicPerpsError::BadInput);
        let data = shard_ai.try_borrow_data()?;
        if data.len() < 8 + ORDER_QUEUE_HEADER { continue; }
        if data[..8] != ORDER_QUEUE_DISCRIMINATOR { continue; }
        let count = (u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize)
            .min(MAX_ORDERS_PER_SHARD);
        for i in 0..count {
            let off = 12 + i * Order::SIZE;
            if off + Order::SIZE > data.len() { break; }
            if let Some(order) = Order::deserialize(&data[off..off + Order::SIZE]) {
                if order.price >= price_lower && order.price <= price_upper {
                    bids.push(OrderEntry {
                        price: order.price,
                        size: order.size,
                        shard_idx: shard_idx as u8,
                        order_idx: i as u8,
                    });
                }
            }
        }
    }

    for (shard_idx, shard_ai) in ask_shards.iter().enumerate() {
        ensure!(shard_ai.owner == program_id, AtomicPerpsError::BadInput);
        let data = shard_ai.try_borrow_data()?;
        if data.len() < 8 + ORDER_QUEUE_HEADER { continue; }
        if data[..8] != ORDER_QUEUE_DISCRIMINATOR { continue; }
        let count = (u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize)
            .min(MAX_ORDERS_PER_SHARD);
        for i in 0..count {
            let off = 12 + i * Order::SIZE;
            if off + Order::SIZE > data.len() { break; }
            if let Some(order) = Order::deserialize(&data[off..off + Order::SIZE]) {
                if order.price >= price_lower && order.price <= price_upper {
                    asks.push(OrderEntry {
                        price: order.price,
                        size: order.size,
                        shard_idx: shard_idx as u8,
                        order_idx: i as u8,
                    });
                }
            }
        }
    }

    // ---- Phase 2: Sort ----
    // Bids: most aggressive (highest price) first
    bids.sort_unstable_by(|a, b| b.price.cmp(&a.price));
    // Asks: most aggressive (lowest price) first
    asks.sort_unstable_by(|a, b| a.price.cmp(&b.price));

    // ---- Phase 3: Find clearing price ----
    let (clearing_price, total_matchable) = find_clearing_price(&bids, &asks);

    // If no match possible, just pay the crank and return
    if clearing_price == 0 || total_matchable == 0 {
        let crank_fee_lamports: u64 = 1_000_000;
        let rent = solana_program::sysvar::rent::Rent::get()?;
        let min_balance = rent.minimum_balance(global_config_ai.data_len());
        let config_lamports = global_config_ai.lamports();
        if config_lamports > crank_fee_lamports + min_balance {
            **global_config_ai.try_borrow_mut_lamports()? -= crank_fee_lamports;
            **crank.try_borrow_mut_lamports()? += crank_fee_lamports;
        }
        return Ok(());
    }

    // Clamp to Pyth cap
    let clearing_price = clearing_price.max(price_lower).min(price_upper);

    // ---- Phase 4: Compute fill amounts ----
    // Track fill amount per order: indexed by position in sorted array
    let mut bid_fills: Vec<u64> = vec![0u64; bids.len()];
    let mut ask_fills: Vec<u64> = vec![0u64; asks.len()];

    let mut filled_bid_vol: u64 = 0;
    for (i, bid) in bids.iter().enumerate() {
        if bid.price < clearing_price { break; }
        let remaining = total_matchable.saturating_sub(filled_bid_vol);
        if remaining == 0 { break; }
        let fill = bid.size.min(remaining);
        bid_fills[i] = fill;
        // Slippage invariant: bid filled at clearing_price <= bid.price
        debug_assert!(clearing_price <= bid.price);
        filled_bid_vol = filled_bid_vol.saturating_add(fill);
    }

    let mut filled_ask_vol: u64 = 0;
    for (i, ask) in asks.iter().enumerate() {
        if ask.price > clearing_price { break; }
        let remaining = total_matchable.saturating_sub(filled_ask_vol);
        if remaining == 0 { break; }
        let fill = ask.size.min(remaining);
        ask_fills[i] = fill;
        // Slippage invariant: ask filled at clearing_price >= ask.price
        debug_assert!(clearing_price >= ask.price);
        filled_ask_vol = filled_ask_vol.saturating_add(fill);
    }

    // ---- Phase 5: Emit fill events (BEFORE compaction so we can read user pubkeys) ----
    let mut num_fills: u16 = 0;

    for (i, bid) in bids.iter().enumerate() {
        if bid_fills[i] == 0 { continue; }
        let shard_ai = &bid_shards[bid.shard_idx as usize];
        let data = shard_ai.try_borrow_data()?;
        let off = 12 + (bid.order_idx as usize) * Order::SIZE;
        if let Some(order) = Order::deserialize(&data[off..off + Order::SIZE]) {
            emit_dfba_fill(&order.user, 0, clearing_price, bid_fills[i]);
            num_fills += 1;
        }
    }

    for (i, ask) in asks.iter().enumerate() {
        if ask_fills[i] == 0 { continue; }
        let shard_ai = &ask_shards[ask.shard_idx as usize];
        let data = shard_ai.try_borrow_data()?;
        let off = 12 + (ask.order_idx as usize) * Order::SIZE;
        if let Some(order) = Order::deserialize(&data[off..off + Order::SIZE]) {
            emit_dfba_fill(&order.user, 1, clearing_price, ask_fills[i]);
            num_fills += 1;
        }
    }

    emit_batch_cleared(clearing_price, pyth_price, total_matchable, num_fills);

    // ---- Phase 6: Compact shards — remove fully filled, update partial fills ----
    // Build a lookup: (shard_idx, order_idx) -> fill_amount for bids
    // Use parallel arrays indexed the same way as our sorted arrays
    compact_shards(bid_shards, &bids, &bid_fills)?;
    compact_shards(ask_shards, &asks, &ask_fills)?;

    // ---- Phase 6b: OI guards (spec: execute_batch requires clauses) ----
    let mut config = load_config(global_config_ai)?;

    // Per-side OI guards
    ensure!(
        config.total_long_oi.saturating_add(filled_bid_vol) <= config.total_usdc_reserve,
        AtomicPerpsError::TVLCapExceeded
    );
    ensure!(
        config.total_short_oi.saturating_add(filled_ask_vol) <= config.total_usdc_reserve,
        AtomicPerpsError::TVLCapExceeded
    );
    // Combined OI guard: formal verification proved per-side guards insufficient
    // to preserve oi_bounded (total_long + total_short <= reserve)
    ensure!(
        config.total_long_oi.saturating_add(filled_bid_vol)
            .saturating_add(config.total_short_oi)
            .saturating_add(filled_ask_vol)
            <= config.total_usdc_reserve,
        AtomicPerpsError::TVLCapExceeded
    );

    // ---- Phase 7: Accounting ----

    // OI update: bid fills add to long OI, ask fills add to short OI
    config.total_long_oi = config.total_long_oi.saturating_add(filled_bid_vol);
    config.total_short_oi = config.total_short_oi.saturating_add(filled_ask_vol);

    // PSF: 10% of matched volume in basis points
    config.psf_balance = config.psf_balance.saturating_add(total_matchable / 10_000);

    save_config(global_config_ai, &config)?;

    // Crank fee: 0.001 SOL — only pay if config has excess lamports above rent
    let crank_fee_lamports: u64 = 1_000_000;
    let rent = solana_program::sysvar::rent::Rent::get()?;
    let min_balance = rent.minimum_balance(global_config_ai.data_len());
    let config_lamports = global_config_ai.lamports();
    if config_lamports > crank_fee_lamports + min_balance {
        **global_config_ai.try_borrow_mut_lamports()? -= crank_fee_lamports;
        **crank.try_borrow_mut_lamports()? += crank_fee_lamports;
    }

    Ok(())
}

/// Compact a set of shards by removing fully filled orders and updating partial fills.
fn compact_shards(
    shard_accounts: &[AccountInfo],
    entries: &[OrderEntry],
    fills: &[u64],
) -> ProgramResult {
    // Build per-shard fill maps: for each (shard_idx, order_idx), what's the fill amount?
    // Since entries may reference the same shard, we group by shard.
    for (shard_idx, shard_ai) in shard_accounts.iter().enumerate() {
        let mut data = shard_ai.try_borrow_mut_data()?;
        if data.len() < 8 + ORDER_QUEUE_HEADER { continue; }
        if data[..8] != ORDER_QUEUE_DISCRIMINATOR { continue; }

        let count = (u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize)
            .min(MAX_ORDERS_PER_SHARD);

        // Build fill lookup for this shard
        let mut order_fill: [u64; 85] = [0u64; 85]; // MAX_ORDERS_PER_SHARD = 85
        for (i, entry) in entries.iter().enumerate() {
            if entry.shard_idx as usize == shard_idx && fills[i] > 0 {
                order_fill[entry.order_idx as usize] = fills[i];
            }
        }

        // Compact: write surviving orders back
        let mut write_idx: usize = 0;
        for read_idx in 0..count {
            let off = 12 + read_idx * Order::SIZE;
            if off + Order::SIZE > data.len() { break; }

            let fill = order_fill[read_idx];
            if fill == 0 {
                // Unfilled — keep as-is, copy to write position
                if write_idx != read_idx {
                    let src_off = 12 + read_idx * Order::SIZE;
                    let dst_off = 12 + write_idx * Order::SIZE;
                    // Copy order bytes
                    for b in 0..Order::SIZE {
                        data[dst_off + b] = data[src_off + b];
                    }
                }
                write_idx += 1;
            } else {
                // Check if partially filled
                let size_off = off + 32 + 8; // user(32) + price(8) -> size starts here
                let original_size = u64::from_le_bytes(
                    data[size_off..size_off + 8].try_into().unwrap()
                );
                if fill < original_size {
                    // Partial fill — update size, keep order
                    let remaining = original_size - fill;
                    let dst_off = 12 + write_idx * Order::SIZE;
                    if write_idx != read_idx {
                        for b in 0..Order::SIZE {
                            data[dst_off + b] = data[12 + read_idx * Order::SIZE + b];
                        }
                    }
                    // Overwrite size with remaining
                    let new_size_off = dst_off + 32 + 8;
                    data[new_size_off..new_size_off + 8]
                        .copy_from_slice(&remaining.to_le_bytes());
                    write_idx += 1;
                }
                // Fully filled — skip (don't increment write_idx)
            }
        }

        // Update count
        data[8..12].copy_from_slice(&(write_idx as u32).to_le_bytes());

        // Zero remaining slots
        let zero_start = 12 + write_idx * Order::SIZE;
        let zero_end = (12 + count * Order::SIZE).min(data.len());
        for b in zero_start..zero_end {
            data[b] = 0;
        }
    }

    Ok(())
}
