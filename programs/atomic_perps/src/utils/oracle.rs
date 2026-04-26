use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    program_error::ProgramError,
};
use crate::errors::AtomicPerpsError;

#[cfg(not(feature = "mock-oracle"))]
use crate::ensure;
#[cfg(not(feature = "mock-oracle"))]
use crate::constants::{MAX_ORACLE_AGE_SECONDS, MAX_ORACLE_CONFIDENCE_BPS, PYTH_SOL_USD_FEED_ID, PYTH_PUSH_ORACLE_PROGRAM};
use crate::constants::JLP_PRICE_SANITY_FACTOR;

#[cfg(not(feature = "mock-oracle"))]
const DISCRIMINATOR: usize = 8;
#[cfg(not(feature = "mock-oracle"))]
const WRITE_AUTHORITY: usize = 32;
#[cfg(not(feature = "mock-oracle"))]
const FEED_ID_OFFSET_PARTIAL: usize = DISCRIMINATOR + WRITE_AUTHORITY + 2;
#[cfg(not(feature = "mock-oracle"))]
const FEED_ID_OFFSET_FULL: usize = DISCRIMINATOR + WRITE_AUTHORITY + 1;

#[cfg(feature = "mock-oracle")]
pub fn validate_and_get_price(
    pyth_feed_account: &AccountInfo,
    _clock: &Clock,
) -> Result<(u64, u64), ProgramError> {
    mock_read_price(pyth_feed_account)
}

#[cfg(feature = "mock-oracle")]
pub fn validate_and_get_price_for_feed(
    pyth_feed_account: &AccountInfo,
    _clock: &Clock,
    _expected_feed_id: &[u8; 32],
) -> Result<(u64, u64), ProgramError> {
    mock_read_price(pyth_feed_account)
}

#[cfg(feature = "mock-oracle")]
fn mock_read_price(
    pyth_feed_account: &AccountInfo,
) -> Result<(u64, u64), ProgramError> {
    // Variable mock: if account has >=16 bytes of data, read price + conf from it.
    // This lets tests write a custom price to an account and pass it as oracle.
    let data = pyth_feed_account.try_borrow_data()?;
    if data.len() >= 16 {
        let price = u64::from_le_bytes(data[0..8].try_into().unwrap());
        let conf = u64::from_le_bytes(data[8..16].try_into().unwrap());
        if price > 0 {
            return Ok((price, conf));
        }
    }
    // Fallback: constant $150 SOL/USD
    Ok((150_000_000, 10_000))
}

#[cfg(not(feature = "mock-oracle"))]
pub fn validate_and_get_price(
    pyth_feed_account: &AccountInfo,
    clock: &Clock,
) -> Result<(u64, u64), ProgramError> {
    validate_and_get_price_for_feed(pyth_feed_account, clock, &PYTH_SOL_USD_FEED_ID)
}

#[cfg(not(feature = "mock-oracle"))]
pub fn validate_and_get_price_for_feed(
    pyth_feed_account: &AccountInfo,
    clock: &Clock,
    expected_feed_id: &[u8; 32],
) -> Result<(u64, u64), ProgramError> {
    ensure!(*pyth_feed_account.owner == PYTH_PUSH_ORACLE_PROGRAM, AtomicPerpsError::InvalidOracleFeed);
    let data = pyth_feed_account.try_borrow_data()?;
    // Minimum: discriminator(8) + write_authority(32) + tag(1) = 41 bytes to read the tag.
    // Full bounds check is done below via msg_end.
    ensure!(data.len() >= DISCRIMINATOR + WRITE_AUTHORITY + 1, AtomicPerpsError::InvalidOracleFeed);

    let tag = data[DISCRIMINATOR + WRITE_AUTHORITY];
    let feed_off = match tag {
        0 => FEED_ID_OFFSET_PARTIAL,
        1 => FEED_ID_OFFSET_FULL,
        _ => return Err(AtomicPerpsError::InvalidOracleFeed.into()),
    };

    let msg_end = feed_off + 32 + 8 + 8 + 4 + 8;
    ensure!(data.len() >= msg_end, AtomicPerpsError::InvalidOracleFeed);

    let feed_id: &[u8] = &data[feed_off..feed_off + 32];
    ensure!(feed_id == expected_feed_id, AtomicPerpsError::InvalidOracleFeed);

    let price_off = feed_off + 32;
    let conf_off = price_off + 8;
    let expo_off = conf_off + 8;
    let ptime_off = expo_off + 4;

    let price = i64::from_le_bytes(data[price_off..price_off + 8].try_into().unwrap());
    let conf = u64::from_le_bytes(data[conf_off..conf_off + 8].try_into().unwrap());
    let expo = i32::from_le_bytes(data[expo_off..expo_off + 4].try_into().unwrap());
    let publish_time = i64::from_le_bytes(data[ptime_off..ptime_off + 8].try_into().unwrap());

    ensure!(price > 0, AtomicPerpsError::InvalidOracleFeed);

    let age = clock.unix_timestamp.saturating_sub(publish_time);
    ensure!(age <= MAX_ORACLE_AGE_SECONDS as i64, AtomicPerpsError::OracleStale);

    let price_abs = price as u64;
    let conf_check = (conf as u128) * 10_000;
    let price_threshold = (price_abs as u128) * (MAX_ORACLE_CONFIDENCE_BPS as u128);
    ensure!(conf_check < price_threshold, AtomicPerpsError::OracleConfidenceTooWide);

    Ok((normalize_to_6dp(price_abs, expo)?, normalize_to_6dp(conf, expo)?))
}

#[cfg(not(feature = "mock-oracle"))]
fn normalize_to_6dp(value: u64, exponent: i32) -> Result<u64, ProgramError> {
    let shift = exponent - (-6);
    if shift >= 0 {
        let f = 10u64.checked_pow(shift as u32).ok_or(AtomicPerpsError::MathOverflow)?;
        value.checked_mul(f).ok_or(AtomicPerpsError::MathOverflow.into())
    } else {
        let f = 10u64.checked_pow((-shift) as u32).ok_or(AtomicPerpsError::MathOverflow)?;
        Ok(value / f)
    }
}

/// Validate Switchboard V2 aggregator price and check divergence from Pyth.
/// Returns Ok(()) if no divergence or if switchboard account is not provided.
/// Returns Err(OracleDivergence) if Pyth and Switchboard diverge by > ORACLE_DIVERGENCE_BPS.
pub fn validate_switchboard_divergence(
    switchboard_ai: &AccountInfo,
    pyth_price_6dp: u64,
) -> Result<(), ProgramError> {
    use crate::constants::{SWITCHBOARD_SOL_USD_FEED, ORACLE_DIVERGENCE_BPS, BPS_DENOMINATOR};
    use crate::ensure;

    // Verify the account is the expected Switchboard aggregator
    ensure!(*switchboard_ai.key == SWITCHBOARD_SOL_USD_FEED, AtomicPerpsError::BadInput);

    let data = switchboard_ai.try_borrow_data()?;
    // Switchboard V2 AggregatorAccountData: f64 result at offset 216, timestamp at 296
    if data.len() < 304 {
        return Err(AtomicPerpsError::BadInput.into());
    }

    // Read IEEE 754 f64 LE at offset 216
    let price_f64 = f64::from_le_bytes(data[216..224].try_into().unwrap());
    if price_f64 <= 0.0 || !price_f64.is_finite() {
        return Err(AtomicPerpsError::BadInput.into());
    }

    // Convert to 6dp
    let sw_price_6dp = (price_f64 * 1_000_000.0) as u64;

    // Check divergence: |pyth - switchboard| / pyth > threshold
    let diff = if pyth_price_6dp > sw_price_6dp {
        pyth_price_6dp - sw_price_6dp
    } else {
        sw_price_6dp - pyth_price_6dp
    };

    let divergence_bps = (diff as u128 * BPS_DENOMINATOR as u128) / (pyth_price_6dp as u128);
    ensure!(
        divergence_bps <= ORACLE_DIVERGENCE_BPS as u128,
        AtomicPerpsError::OracleDivergence
    );

    Ok(())
}

/// Validate JLP price (passed as instruction data) against SOL price sanity bounds.
/// JLP has no Pyth feed — caller supplies the Jupiter pool virtual price.
/// Sanity check: jlp_price must be within [sol_price / FACTOR, sol_price * FACTOR].
pub fn validate_jlp_price(jlp_price_6dp: u64, sol_price_6dp: u64) -> Result<(), ProgramError> {
    if jlp_price_6dp == 0 || sol_price_6dp == 0 {
        return Err(AtomicPerpsError::JlpPriceOutOfRange.into());
    }
    let lower = sol_price_6dp / JLP_PRICE_SANITY_FACTOR;
    let upper = sol_price_6dp.saturating_mul(JLP_PRICE_SANITY_FACTOR);
    if jlp_price_6dp < lower || jlp_price_6dp > upper {
        return Err(AtomicPerpsError::JlpPriceOutOfRange.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_validate_jlp_price_in_range() {
        // $200 JLP with $150 SOL → bounds [75, 300], 200 is in range
        assert!(validate_jlp_price(200_000_000, 150_000_000).is_ok());
        // JLP price equals SOL price → always valid
        assert!(validate_jlp_price(150_000_000, 150_000_000).is_ok());
    }

    #[test]
    fn test_validate_jlp_price_lower_bound() {
        // SOL = $150, factor = 2, lower = 150/2 = $75
        // $75 exactly → Ok
        assert!(validate_jlp_price(75_000_000, 150_000_000).is_ok());
        // $74.999999 → Err (below lower bound)
        assert!(validate_jlp_price(74_999_999, 150_000_000).is_err());
    }

    #[test]
    fn test_validate_jlp_price_upper_bound() {
        // SOL = $150, factor = 2, upper = 150*2 = $300
        // $300 exactly → Ok
        assert!(validate_jlp_price(300_000_000, 150_000_000).is_ok());
        // $300.000001 → Err (above upper bound)
        assert!(validate_jlp_price(300_000_001, 150_000_000).is_err());
    }

    #[test]
    fn test_validate_jlp_price_zero() {
        // Zero JLP price → Err
        assert!(validate_jlp_price(0, 150_000_000).is_err());
        // Zero SOL price → Err
        assert!(validate_jlp_price(100_000_000, 0).is_err());
        // Both zero → Err
        assert!(validate_jlp_price(0, 0).is_err());
    }

    #[test]
    fn test_validate_jlp_price_large_sol() {
        // Large SOL price — saturating_mul prevents overflow
        let large_sol = u64::MAX / 10;
        // upper = large_sol * 2 would overflow, saturating_mul caps at u64::MAX
        // Any JLP price <= u64::MAX should be in range (upper = u64::MAX)
        assert!(validate_jlp_price(large_sol, large_sol).is_ok());
        // Lower bound = large_sol / 2
        let lower = large_sol / 2;
        assert!(validate_jlp_price(lower, large_sol).is_ok());
        assert!(validate_jlp_price(lower - 1, large_sol).is_err());
    }
}

