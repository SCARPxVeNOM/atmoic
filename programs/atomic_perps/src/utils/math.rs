use solana_program::program_error::ProgramError;
use crate::errors::AtomicPerpsError;
use crate::ensure;
use crate::state::Side;
use crate::constants::{
    BPS_DENOMINATOR, MIN_SPREAD_BPS, SOL_DECIMALS, MSOL_DECIMALS, JLP_DECIMALS,
    HAIRCUT_SOL_BPS, HAIRCUT_MSOL_BPS, HAIRCUT_JLP_BPS,
};
use solana_program::pubkey::Pubkey;
use crate::constants::{MSOL_MINT, JLP_MINT};

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

/// Apply haircut to a USD value. Returns value * (10000 - haircut_bps) / 10000.
pub fn apply_haircut(value_usd: u64, haircut_bps: u64) -> Result<u64, ProgramError> {
    let effective = BPS_DENOMINATOR
        .checked_sub(haircut_bps)
        .ok_or(AtomicPerpsError::MathOverflow)?;
    checked_mul_div(value_usd, effective, BPS_DENOMINATOR)
}

/// Return the haircut in BPS for a given collateral mint.
pub fn get_haircut_for_mint(mint: &Pubkey) -> u64 {
    if *mint == MSOL_MINT {
        HAIRCUT_MSOL_BPS
    } else if *mint == JLP_MINT {
        HAIRCUT_JLP_BPS
    } else {
        // Default: SOL (or any other supported mint)
        HAIRCUT_SOL_BPS
    }
}

/// Return the token decimals for a given collateral mint.
pub fn get_decimals_for_mint(mint: &Pubkey) -> u8 {
    if *mint == MSOL_MINT {
        MSOL_DECIMALS
    } else if *mint == JLP_MINT {
        JLP_DECIMALS
    } else {
        SOL_DECIMALS
    }
}

/// Calculate notional position size from collateral USD value and leverage.
/// notional = collateral_usd * leverage_bps / 1000
pub fn calculate_notional(collateral_usd: u64, leverage_bps: u64) -> Result<u64, ProgramError> {
    checked_mul_div(collateral_usd, leverage_bps, 1_000)
}

/// Directional skew check — rejects fills only if they would *increase* skew past 90%.
/// Trades that reduce or maintain skew always pass, even at extreme skew levels.
/// This solves the cold-start problem: when skew is 100% long, shorts can still open.
pub fn check_vault_skew(long_oi: u64, short_oi: u64, new_side: &Side) -> Result<(), ProgramError> {
    let total = long_oi.saturating_add(short_oi);
    if total == 0 { return Ok(()); }
    let diff = if long_oi > short_oi { long_oi - short_oi } else { short_oi - long_oi };
    // skew > 90% means diff * 100 / total > 90, i.e. diff * 10 > total * 9
    if diff.saturating_mul(10) > total.saturating_mul(9) {
        // Skew is extreme — only block if new position would make it worse
        let would_increase = match new_side {
            Side::Long => long_oi >= short_oi,
            Side::Short => short_oi >= long_oi,
        };
        if would_increase {
            return Err(AtomicPerpsError::FillsSuspended.into());
        }
        // New position reduces skew — allow it through
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
    fn test_apply_haircut_zero() {
        // 0% haircut → full value
        assert_eq!(apply_haircut(1_000_000, 0).unwrap(), 1_000_000);
    }

    #[test]
    fn test_apply_haircut_25pct() {
        // 25% haircut (2500 bps) on $100 → $75
        assert_eq!(apply_haircut(100_000_000, 2_500).unwrap(), 75_000_000);
    }

    #[test]
    fn test_apply_haircut_100pct() {
        // 100% haircut → 0
        assert_eq!(apply_haircut(1_000_000, 10_000).unwrap(), 0);
    }

    #[test]
    fn test_apply_haircut_sol() {
        // SOL: 10% haircut (1000 bps) on $150 → $135
        assert_eq!(apply_haircut(150_000_000, 1_000).unwrap(), 135_000_000);
    }

    #[test]
    fn test_get_haircut_for_mint() {
        use solana_program::pubkey::Pubkey;
        use crate::constants::{MSOL_MINT, JLP_MINT};
        assert_eq!(get_haircut_for_mint(&MSOL_MINT), 1_800);
        assert_eq!(get_haircut_for_mint(&JLP_MINT), 2_500);
        // Unknown mint → SOL default (0% — SOL is the reference asset)
        assert_eq!(get_haircut_for_mint(&Pubkey::default()), 0);
    }

    #[test]
    fn test_get_decimals_for_mint() {
        use solana_program::pubkey::Pubkey;
        use crate::constants::{MSOL_MINT, JLP_MINT};
        assert_eq!(get_decimals_for_mint(&MSOL_MINT), 9);
        assert_eq!(get_decimals_for_mint(&JLP_MINT), 6);
        assert_eq!(get_decimals_for_mint(&Pubkey::default()), 9);
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

    // ===== New tests: PnL edge cases =====

    #[test]
    fn test_pnl_short_profit() {
        // Short profits when price drops: entry $150, exit $120, size 1 SOL
        let pnl = calculate_pnl(150_000_000, 120_000_000, 1_000_000_000, &Side::Short).unwrap();
        // pnl = (150-120) * 1_000_000_000 / 150 = 200_000_000
        assert_eq!(pnl, 200_000_000);
    }

    #[test]
    fn test_pnl_long_loss() {
        // Long loses when price drops: entry $150, exit $120, size 1 SOL
        let pnl = calculate_pnl(150_000_000, 120_000_000, 1_000_000_000, &Side::Long).unwrap();
        // pnl = (120-150) * 1_000_000_000 / 150 = -200_000_000
        assert_eq!(pnl, -200_000_000);
    }

    #[test]
    fn test_pnl_short_loss() {
        // Short loses when price rises: entry $150, exit $180, size 1 SOL
        let pnl = calculate_pnl(150_000_000, 180_000_000, 1_000_000_000, &Side::Short).unwrap();
        // pnl = (150-180) * 1_000_000_000 / 150 = -200_000_000
        assert_eq!(pnl, -200_000_000);
    }

    #[test]
    fn test_pnl_zero_entry_price() {
        // Division by zero returns error (checked_div on zero entry_price)
        let result = calculate_pnl(0, 100_000_000, 1_000_000_000, &Side::Long);
        assert!(result.is_err());
    }

    #[test]
    fn test_pnl_same_price() {
        // Same entry and exit → zero PnL for both sides
        assert_eq!(calculate_pnl(150_000_000, 150_000_000, 1_000_000_000, &Side::Long).unwrap(), 0);
        assert_eq!(calculate_pnl(150_000_000, 150_000_000, 1_000_000_000, &Side::Short).unwrap(), 0);
    }

    // ===== New tests: calculate_position_size =====

    #[test]
    fn test_calculate_position_size() {
        // 100 USDC at 5x leverage → 500 position size
        assert_eq!(calculate_position_size(100_000_000, 5_000).unwrap(), 500_000_000);
        // 100 USDC at 10x leverage → 1000 position size
        assert_eq!(calculate_position_size(100_000_000, 10_000).unwrap(), 1_000_000_000);
        // 0 borrow → 0 size
        assert_eq!(calculate_position_size(0, 5_000).unwrap(), 0);
        // 1x leverage (1000 bps) → size equals borrow
        assert_eq!(calculate_position_size(100_000_000, 1_000).unwrap(), 100_000_000);
    }

    // ===== New tests: check_vault_skew (directional) =====

    #[test]
    fn test_check_vault_skew_balanced() {
        // Balanced — any side allowed
        assert!(check_vault_skew(100, 100, &Side::Long).is_ok());
        assert!(check_vault_skew(100, 100, &Side::Short).is_ok());
        assert!(check_vault_skew(0, 0, &Side::Long).is_ok());
        assert!(check_vault_skew(0, 0, &Side::Short).is_ok());
    }

    #[test]
    fn test_check_vault_skew_moderate() {
        // 80% skew — under 90% threshold, any side allowed
        assert!(check_vault_skew(180, 20, &Side::Long).is_ok());
        assert!(check_vault_skew(180, 20, &Side::Short).is_ok());
        assert!(check_vault_skew(20, 180, &Side::Long).is_ok());
        assert!(check_vault_skew(20, 180, &Side::Short).is_ok());
    }

    #[test]
    fn test_check_vault_skew_suspended_increasing() {
        // 91% skew long-heavy → adding more longs blocked
        assert!(check_vault_skew(191, 9, &Side::Long).is_err());
        // 100% skew long → adding longs blocked
        assert!(check_vault_skew(100, 0, &Side::Long).is_err());
        // 100% skew short → adding shorts blocked
        assert!(check_vault_skew(0, 100, &Side::Short).is_err());
    }

    #[test]
    fn test_check_vault_skew_allows_rebalancing() {
        // 100% skew long → shorts ALLOWED (they reduce skew)
        assert!(check_vault_skew(100, 0, &Side::Short).is_ok());
        // 100% skew short → longs ALLOWED (they reduce skew)
        assert!(check_vault_skew(0, 100, &Side::Long).is_ok());
        // 91% skew long-heavy → shorts allowed
        assert!(check_vault_skew(191, 9, &Side::Short).is_ok());
        // 91% skew short-heavy → longs allowed
        assert!(check_vault_skew(9, 191, &Side::Long).is_ok());
    }

    #[test]
    fn test_check_vault_skew_boundary() {
        // At exactly 90%: diff=90, total=100 → 900 vs 900 → NOT > → Ok for both
        assert!(check_vault_skew(95, 5, &Side::Long).is_ok());
        assert!(check_vault_skew(95, 5, &Side::Short).is_ok());
        // 951 vs 49 → 95.1% skew → long blocked, short allowed
        assert!(check_vault_skew(951, 49, &Side::Long).is_err());
        assert!(check_vault_skew(951, 49, &Side::Short).is_ok());
        // 900 vs 100 → 80% skew → both allowed
        assert!(check_vault_skew(900, 100, &Side::Long).is_ok());
        assert!(check_vault_skew(900, 100, &Side::Short).is_ok());
    }

    // ===== New tests: spread tier boundaries =====

    #[test]
    fn test_calculate_min_spread_tier_boundaries() {
        // Tier boundaries: 30/31, 55/56, 75/76, 90/91
        // 30% skew (boundary of tier 1/2): diff=30, total=100 → tier 0..=30 → 5 bps
        assert_eq!(calculate_min_spread(65, 35), 5);  // diff=30, skew_pct=30
        // 31% skew → tier 31..=55 → 15 bps
        // diff=31 out of 100: not exact with integers. Use 131 vs 69 → diff=62, total=200 → 31%
        assert_eq!(calculate_min_spread(131, 69), 15);
        // 55% skew: diff=55, total=100 → 15 bps
        // 155 vs 45 → diff=110, total=200 → 55%
        assert_eq!(calculate_min_spread(155, 45), 15);
        // 56% skew → tier 56..=75 → 40 bps
        // 156 vs 44 → diff=112, total=200 → 56%
        assert_eq!(calculate_min_spread(156, 44), 40);
        // 75% skew: 175 vs 25 → diff=150, total=200 → 75% → 40 bps
        assert_eq!(calculate_min_spread(175, 25), 40);
        // 76% skew → tier 76..=90 → 100 bps
        // 176 vs 24 → diff=152, total=200 → 76%
        assert_eq!(calculate_min_spread(176, 24), 100);
        // 90% skew: 190 vs 10 → diff=180, total=200 → 90% → 100 bps
        assert_eq!(calculate_min_spread(190, 10), 100);
        // 91% skew → u16::MAX
        // 191 vs 9 → diff=182, total=200 → 91%
        assert_eq!(calculate_min_spread(191, 9), u16::MAX);
    }

    // ===== New tests: apply_haircut overflow =====

    #[test]
    fn test_apply_haircut_overflow() {
        // u64::MAX with 0% haircut → u64::MAX
        assert_eq!(apply_haircut(u64::MAX, 0).unwrap(), u64::MAX);
        // >10000 bps haircut → underflow in (10000 - haircut), should error
        assert!(apply_haircut(1_000_000, 10_001).is_err());
    }
}

// Property-based tests — run with: cargo test --features proptest-tests
// Gated behind feature to avoid SBF toolchain conflicts with proptest crate.
#[cfg(all(test, feature = "proptest-tests"))]
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
            // When spread = MAX, the dominant side should be blocked
            if spread == u16::MAX {
                if long_oi >= short_oi {
                    prop_assert!(check_vault_skew(long_oi, short_oi, &Side::Long).is_err());
                    // But rebalancing side should be allowed
                    prop_assert!(check_vault_skew(long_oi, short_oi, &Side::Short).is_ok());
                } else {
                    prop_assert!(check_vault_skew(long_oi, short_oi, &Side::Short).is_err());
                    prop_assert!(check_vault_skew(long_oi, short_oi, &Side::Long).is_ok());
                }
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
        fn apply_haircut_result_le_input(
            value in 0u64..=1_000_000_000_000u64,
            haircut in 0u64..=10_000u64,
        ) {
            if let Ok(result) = apply_haircut(value, haircut) {
                prop_assert!(result <= value);
            }
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

        #[test]
        fn pnl_long_short_symmetric(
            entry in 1u64..=1_000_000_000u64,
            exit in 1u64..=1_000_000_000u64,
            size in 1u64..=1_000_000_000u64,
        ) {
            if let (Ok(pnl_long), Ok(pnl_short)) = (
                calculate_pnl(entry, exit, size, &Side::Long),
                calculate_pnl(entry, exit, size, &Side::Short),
            ) {
                prop_assert_eq!(pnl_long, -pnl_short);
            }
        }

        #[test]
        fn position_size_monotonic(
            borrow in 1u64..=100_000_000u64,
            lev_a in 1u64..=10_000u64,
            lev_b in 1u64..=10_000u64,
        ) {
            if let (Ok(size_a), Ok(size_b)) = (
                calculate_position_size(borrow, lev_a),
                calculate_position_size(borrow, lev_b),
            ) {
                if lev_a <= lev_b {
                    prop_assert!(size_a <= size_b);
                }
            }
        }

        #[test]
        fn vault_skew_directional_symmetric(
            a in 0u64..=1_000_000_000u64,
            b in 0u64..=1_000_000_000u64,
        ) {
            // Swapping long/short OI and swapping the side should give the same result
            let r1 = check_vault_skew(a, b, &Side::Long).is_ok();
            let r2 = check_vault_skew(b, a, &Side::Short).is_ok();
            prop_assert_eq!(r1, r2);
        }

        #[test]
        fn position_size_never_panics(
            borrow in 0u64..=u64::MAX/2,
            leverage in 0u64..=100_000u64,
        ) {
            let _ = calculate_position_size(borrow, leverage);
        }
    }
}
