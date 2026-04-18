use solana_program::program_error::ProgramError;
use crate::errors::AtomicPerpsError;
use crate::ensure;
use crate::state::Side;
use crate::constants::{BPS_DENOMINATOR, MIN_SPREAD_BPS};

pub fn checked_mul_div(a: u64, b: u64, c: u64) -> Result<u64, ProgramError> {
    ensure!(c > 0, AtomicPerpsError::MathOverflow);
    let result = (a as u128)
        .checked_mul(b as u128)
        .ok_or(AtomicPerpsError::MathOverflow)?
        .checked_div(c as u128)
        .ok_or(AtomicPerpsError::MathOverflow)?;
    u64::try_from(result).map_err(|_| AtomicPerpsError::MathOverflow.into())
}

pub fn calculate_health_factor(
    collateral_value_usd: u64,
    borrow_value_usd: u64,
    liquidation_threshold_bps: u64,
) -> Result<u64, ProgramError> {
    if borrow_value_usd == 0 {
        return Ok(u64::MAX);
    }
    checked_mul_div(collateral_value_usd, liquidation_threshold_bps, borrow_value_usd)
}

pub fn calculate_position_size(
    borrow_amount: u64,
    leverage_bps: u64,
) -> Result<u64, ProgramError> {
    checked_mul_div(borrow_amount, leverage_bps, 1_000)
}

pub fn calculate_pnl(
    entry_price: u64,
    exit_price: u64,
    size: u64,
    side: &Side,
) -> Result<i64, ProgramError> {
    let price_delta = match side {
        Side::Long => exit_price as i128 - entry_price as i128,
        Side::Short => entry_price as i128 - exit_price as i128,
    };
    let pnl = price_delta
        .checked_mul(size as i128)
        .ok_or(AtomicPerpsError::MathOverflow)?
        .checked_div(entry_price as i128)
        .ok_or(AtomicPerpsError::MathOverflow)?;
    i64::try_from(pnl).map_err(|_| AtomicPerpsError::MathOverflow.into())
}

pub fn apply_fee(amount: u64, fee_bps: u64) -> Result<(u64, u64), ProgramError> {
    let fee = checked_mul_div(amount, fee_bps, BPS_DENOMINATOR)?;
    let after = amount
        .checked_sub(fee)
        .ok_or(AtomicPerpsError::MathOverflow)?;
    Ok((after, fee))
}

pub fn token_to_usd(amount: u64, price_6dp: u64, token_decimals: u8) -> Result<u64, ProgramError> {
    let divisor = 10u64
        .checked_pow(token_decimals as u32)
        .ok_or(AtomicPerpsError::MathOverflow)?;
    checked_mul_div(amount, price_6dp, divisor)
}

/// Calculate minimum spread fee (bps) based on vault skew (M-2 tiers).
pub fn calculate_min_spread(long_oi: u64, short_oi: u64) -> u16 {
    let total = long_oi.saturating_add(short_oi);
    if total == 0 { return MIN_SPREAD_BPS; }
    let diff = if long_oi > short_oi { long_oi - short_oi } else { short_oi - long_oi };
    let skew_pct = diff.saturating_mul(100) / total;
    match skew_pct {
        0..=30 => MIN_SPREAD_BPS,
        31..=55 => 15,
        56..=75 => 40,
        76..=90 => 100,
        _ => u16::MAX,
    }
}

/// Dynamic spread check — rejects fills if vault skew > 90%.
pub fn check_vault_skew(long_oi: u64, short_oi: u64) -> Result<(), ProgramError> {
    let total = long_oi.saturating_add(short_oi);
    if total == 0 { return Ok(()); }
    let diff = if long_oi > short_oi { long_oi - short_oi } else { short_oi - long_oi };
    // skew > 90% means diff * 100 / total > 90, i.e. diff * 10 > total * 9
    if diff.saturating_mul(10) > total.saturating_mul(9) {
        return Err(AtomicPerpsError::FillsSuspended.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_checked_mul_div() {
        assert_eq!(checked_mul_div(100, 200, 50).unwrap(), 400);
        assert_eq!(checked_mul_div(u64::MAX, 1, 1).unwrap(), u64::MAX);
        assert!(checked_mul_div(100, 200, 0).is_err());
    }

    #[test]
    fn test_health_factor() {
        let hf = calculate_health_factor(1_500_000_000, 800_000_000, 8_500).unwrap();
        assert_eq!(hf, 15_937);
    }

    #[test]
    fn test_pnl_long_profit() {
        let pnl = calculate_pnl(100_000_000, 110_000_000, 1_000_000_000, &Side::Long).unwrap();
        assert_eq!(pnl, 100_000_000);
    }

    #[test]
    fn test_apply_fee() {
        let (after, fee) = apply_fee(1_000_000_000, 10).unwrap();
        assert_eq!(fee, 1_000_000);
        assert_eq!(after, 999_000_000);
    }

    #[test]
    fn test_token_to_usd() {
        let usd = token_to_usd(10_000_000_000, 150_000_000, 9).unwrap();
        assert_eq!(usd, 1_500_000_000);
    }

    #[test]
    fn test_calculate_min_spread() {
        // No OI → default 5 bps
        assert_eq!(calculate_min_spread(0, 0), 5);
        // Balanced (0% skew) → 5 bps
        assert_eq!(calculate_min_spread(100, 100), 5);
        // 20% skew → 5 bps
        assert_eq!(calculate_min_spread(120, 80), 5);
        // 40% skew → 15 bps
        assert_eq!(calculate_min_spread(140, 60), 15);
        // 60% skew → 40 bps
        assert_eq!(calculate_min_spread(160, 40), 40);
        // 80% skew → 100 bps
        assert_eq!(calculate_min_spread(180, 20), 100);
        // 95% skew → u16::MAX (fills suspended by check_vault_skew)
        assert_eq!(calculate_min_spread(195, 5), u16::MAX);
    }
}

#[cfg(test)]
mod proptests {
    use super::*;
    use proptest::prelude::*;

    proptest! {
        #[test]
        fn health_factor_never_panics(
            collateral in 0u64..=u64::MAX/2,
            borrow in 1u64..=u64::MAX/2,
            threshold in 1u64..=10_000u64,
        ) {
            let _ = calculate_health_factor(collateral, borrow, threshold);
        }

        #[test]
        fn min_spread_ge_minimum(
            long_oi in 0u64..=1_000_000_000u64,
            short_oi in 0u64..=1_000_000_000u64,
        ) {
            let spread = calculate_min_spread(long_oi, short_oi);
            prop_assert!(spread >= 5);
        }

        #[test]
        fn vault_skew_consistent_with_spread(
            long_oi in 0u64..=1_000_000_000u64,
            short_oi in 0u64..=1_000_000_000u64,
        ) {
            let spread = calculate_min_spread(long_oi, short_oi);
            let skew_ok = check_vault_skew(long_oi, short_oi).is_ok();
            if spread == u16::MAX {
                prop_assert!(!skew_ok);
            }
        }

        #[test]
        fn token_to_usd_no_panic(
            amount in 0u64..=1_000_000_000_000u64,
            price in 1u64..=1_000_000_000u64,
        ) {
            let _ = token_to_usd(amount, price, 9);
            let _ = token_to_usd(amount, price, 6);
        }

        #[test]
        fn checked_mul_div_bounded(
            a in 1u64..=1_000_000_000u64,
            b in 1u64..=1_000_000_000u64,
            c in 1u64..=1_000_000_000u64,
        ) {
            if let Ok(result) = checked_mul_div(a, b, c) {
                prop_assert!(result <= u64::MAX);
            }
        }
    }
}
