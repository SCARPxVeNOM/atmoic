use solana_program::{log::sol_log_data, pubkey::Pubkey};

pub fn emit_config_initialized(
    authority: &Pubkey, max_leverage: u64, liquidation_threshold: u64,
    protocol_fee_bps: u64, max_tvl: u64,
) {
    let mut buf = [0u8; 72];
    buf[0..8].copy_from_slice(b"CFINIT__");
    buf[8..40].copy_from_slice(authority.as_ref());
    buf[40..48].copy_from_slice(&max_leverage.to_le_bytes());
    buf[48..56].copy_from_slice(&liquidation_threshold.to_le_bytes());
    buf[56..64].copy_from_slice(&protocol_fee_bps.to_le_bytes());
    buf[64..72].copy_from_slice(&max_tvl.to_le_bytes());
    sol_log_data(&[&buf]);
}

pub fn emit_position_opened(
    owner: &Pubkey, collateral_amount: u64, borrow_amount: u64,
    side: u8, entry_price: u64, leverage_bps: u64,
) {
    let mut buf = [0u8; 73];
    buf[0..8].copy_from_slice(b"POSOPEN_");
    buf[8..40].copy_from_slice(owner.as_ref());
    buf[40..48].copy_from_slice(&collateral_amount.to_le_bytes());
    buf[48..56].copy_from_slice(&borrow_amount.to_le_bytes());
    buf[56] = side;
    buf[57..65].copy_from_slice(&entry_price.to_le_bytes());
    buf[65..73].copy_from_slice(&leverage_bps.to_le_bytes());
    sol_log_data(&[&buf[..73]]);
}

pub fn emit_position_closed(
    owner: &Pubkey, exit_price: u64, pnl: i64, collateral_returned: u64,
) {
    let mut buf = [0u8; 64];
    buf[0..8].copy_from_slice(b"POSCLOSE");
    buf[8..40].copy_from_slice(owner.as_ref());
    buf[40..48].copy_from_slice(&exit_price.to_le_bytes());
    buf[48..56].copy_from_slice(&pnl.to_le_bytes());
    buf[56..64].copy_from_slice(&collateral_returned.to_le_bytes());
    sol_log_data(&[&buf]);
}

pub fn emit_position_liquidated(
    owner: &Pubkey, liquidator: &Pubkey, health_factor: u64, collateral_seized: u64,
    close_pct_bps: u64,
) {
    let mut buf = [0u8; 96];
    buf[0..8].copy_from_slice(b"POSLIQD_");
    buf[8..40].copy_from_slice(owner.as_ref());
    buf[40..72].copy_from_slice(liquidator.as_ref());
    buf[72..80].copy_from_slice(&health_factor.to_le_bytes());
    buf[80..88].copy_from_slice(&collateral_seized.to_le_bytes());
    buf[88..96].copy_from_slice(&close_pct_bps.to_le_bytes());
    sol_log_data(&[&buf]);
}

pub fn emit_batch_cleared(
    clearing_price: u64, pyth_price: u64,
    total_volume: u64, num_fills: u16,
) {
    let mut buf = [0u8; 34];
    buf[0..8].copy_from_slice(b"BATCHCLR");
    buf[8..16].copy_from_slice(&clearing_price.to_le_bytes());
    buf[16..24].copy_from_slice(&pyth_price.to_le_bytes());
    buf[24..32].copy_from_slice(&total_volume.to_le_bytes());
    buf[32..34].copy_from_slice(&num_fills.to_le_bytes());
    sol_log_data(&[&buf]);
}

pub fn emit_dfba_fill(
    user: &Pubkey, side: u8,
    clearing_price: u64, fill_size: u64,
) {
    let mut buf = [0u8; 57];
    buf[0..8].copy_from_slice(b"DFBAFILL");
    buf[8..40].copy_from_slice(user.as_ref());
    buf[40] = side;
    buf[41..49].copy_from_slice(&clearing_price.to_le_bytes());
    buf[49..57].copy_from_slice(&fill_size.to_le_bytes());
    sol_log_data(&[&buf]);
}

pub fn emit_psf_low(psf_balance: u64, threshold: u64) {
    let mut buf = [0u8; 24];
    buf[0..8].copy_from_slice(b"PSFLOW__");
    buf[8..16].copy_from_slice(&psf_balance.to_le_bytes());
    buf[16..24].copy_from_slice(&threshold.to_le_bytes());
    sol_log_data(&[&buf]);
}

pub fn emit_stress_triggered(owner: &Pubkey, collateral_type: u8) {
    let mut buf = [0u8; 41];
    buf[0..8].copy_from_slice(b"STRESBLK");
    buf[8..40].copy_from_slice(owner.as_ref());
    buf[40] = collateral_type;
    sol_log_data(&[&buf]);
}

pub fn emit_funding_settled(
    position_owner: &Pubkey, funding_rate_bps: i64,
    adjustment: i64, new_collateral: u64,
) {
    let mut buf = [0u8; 64];
    buf[0..8].copy_from_slice(b"FUNDSTTL");
    buf[8..40].copy_from_slice(position_owner.as_ref());
    buf[40..48].copy_from_slice(&funding_rate_bps.to_le_bytes());
    buf[48..56].copy_from_slice(&adjustment.to_le_bytes());
    buf[56..64].copy_from_slice(&new_collateral.to_le_bytes());
    sol_log_data(&[&buf]);
}

pub fn emit_config_updated(
    authority: &Pubkey, protocol_fee_bps: u64, max_leverage: u64, max_tvl: u64,
) {
    let mut buf = [0u8; 64];
    buf[0..8].copy_from_slice(b"CFGUPD__");
    buf[8..40].copy_from_slice(authority.as_ref());
    buf[40..48].copy_from_slice(&protocol_fee_bps.to_le_bytes());
    buf[48..56].copy_from_slice(&max_leverage.to_le_bytes());
    buf[56..64].copy_from_slice(&max_tvl.to_le_bytes());
    sol_log_data(&[&buf]);
}

pub fn emit_correlated_cap_hit(owner: &Pubkey, current_pct_bps: u64, cap_bps: u64) {
    let mut buf = [0u8; 56];
    buf[0..8].copy_from_slice(b"CORRCAP_");
    buf[8..40].copy_from_slice(owner.as_ref());
    buf[40..48].copy_from_slice(&current_pct_bps.to_le_bytes());
    buf[48..56].copy_from_slice(&cap_bps.to_le_bytes());
    sol_log_data(&[&buf]);
}
