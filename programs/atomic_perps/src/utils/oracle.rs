use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    program_error::ProgramError,
};
use crate::errors::AtomicPerpsError;

#[cfg(not(feature = "mock-oracle"))]
use crate::ensure;
#[cfg(not(feature = "mock-oracle"))]
use crate::constants::{MAX_ORACLE_AGE_SECONDS, MAX_ORACLE_CONFIDENCE_BPS, PYTH_SOL_USD_FEED_ID};

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
    let data = pyth_feed_account.try_borrow_data()?;
    ensure!(data.len() >= 150, AtomicPerpsError::InvalidOracleFeed);

    let tag = data[DISCRIMINATOR + WRITE_AUTHORITY];
    let feed_off = match tag {
        0 => FEED_ID_OFFSET_PARTIAL,
        1 => FEED_ID_OFFSET_FULL,
        _ => return Err(AtomicPerpsError::InvalidOracleFeed.into()),
    };

    let msg_end = feed_off + 32 + 8 + 8 + 4 + 8;
    ensure!(data.len() >= msg_end, AtomicPerpsError::InvalidOracleFeed);

    let feed_id: &[u8] = &data[feed_off..feed_off + 32];
    ensure!(feed_id == PYTH_SOL_USD_FEED_ID, AtomicPerpsError::InvalidOracleFeed);

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

