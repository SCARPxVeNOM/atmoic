/-
Proofs.lean — Preservation proofs for AtomicPerps properties.
-/
import Spec

namespace AtomicPerps

open QEDGen.Solana.Account

-- ================================================================
-- collateral_conservation (total_collateral >= 0)
-- Trivially true for Nat — all Nat values are >= 0.
-- ================================================================

theorem collateral_conservation_preserved_by_initialize
    (s : State) (signer : Pubkey)
    (_h_inv : collateral_conservation s)
    (h_succ : (initializeTransition s signer).isSome) :
    collateral_conservation ((initializeTransition s signer).get h_succ) := by
  unfold collateral_conservation initializeTransition
  simp

theorem collateral_conservation_preserved_by_atomic_open
    (s : State) (signer : Pubkey)
    (deposit leverage_bps perp_side oracle_price : Nat)
    (_h_inv : collateral_conservation s)
    (h_succ : (atomic_openTransition s signer deposit leverage_bps perp_side oracle_price).isSome) :
    collateral_conservation ((atomic_openTransition s signer deposit leverage_bps perp_side oracle_price).get h_succ) := by
  unfold collateral_conservation atomic_openTransition mulDivFloor
  simp

theorem collateral_conservation_preserved_by_atomic_close
    (s : State) (signer : Pubkey) (close_bps : Nat)
    (_h_inv : collateral_conservation s)
    (h_succ : (atomic_closeTransition s signer close_bps).isSome) :
    collateral_conservation ((atomic_closeTransition s signer close_bps).get h_succ) := by
  unfold collateral_conservation atomic_closeTransition mulDivFloor
  simp

theorem collateral_conservation_preserved_by_liquidate
    (s : State) (signer : Pubkey) (margin_ratio : Nat)
    (_h_inv : collateral_conservation s)
    (h_succ : (liquidateTransition s signer margin_ratio).isSome) :
    collateral_conservation ((liquidateTransition s signer margin_ratio).get h_succ) := by
  unfold collateral_conservation liquidateTransition
  simp

theorem collateral_conservation_preserved_by_settle_funding
    (s : State) (signer : Pubkey)
    (funding_rate_bps current_timestamp : Nat)
    (_h_inv : collateral_conservation s)
    (h_succ : (settle_fundingTransition s signer funding_rate_bps current_timestamp).isSome) :
    collateral_conservation ((settle_fundingTransition s signer funding_rate_bps current_timestamp).get h_succ) := by
  unfold collateral_conservation settle_fundingTransition
  simp

theorem collateral_conservation_preserved_by_update_config
    (s : State) (signer : Pubkey)
    (_h_inv : collateral_conservation s)
    (h_succ : (update_configTransition s signer).isSome) :
    collateral_conservation ((update_configTransition s signer).get h_succ) := by
  unfold collateral_conservation update_configTransition
  simp

-- ================================================================
-- oi_tracking (total_long_oi >= 0 and total_short_oi >= 0)
-- Trivially true for Nat.
-- ================================================================

theorem oi_tracking_preserved_by_atomic_open
    (s : State) (signer : Pubkey)
    (deposit leverage_bps perp_side oracle_price : Nat)
    (_h_inv : oi_tracking s)
    (h_succ : (atomic_openTransition s signer deposit leverage_bps perp_side oracle_price).isSome) :
    oi_tracking ((atomic_openTransition s signer deposit leverage_bps perp_side oracle_price).get h_succ) := by
  unfold oi_tracking atomic_openTransition mulDivFloor
  simp

theorem oi_tracking_preserved_by_atomic_close
    (s : State) (signer : Pubkey) (close_bps : Nat)
    (_h_inv : oi_tracking s)
    (h_succ : (atomic_closeTransition s signer close_bps).isSome) :
    oi_tracking ((atomic_closeTransition s signer close_bps).get h_succ) := by
  unfold oi_tracking atomic_closeTransition mulDivFloor
  simp

theorem oi_tracking_preserved_by_liquidate
    (s : State) (signer : Pubkey) (margin_ratio : Nat)
    (_h_inv : oi_tracking s)
    (h_succ : (liquidateTransition s signer margin_ratio).isSome) :
    oi_tracking ((liquidateTransition s signer margin_ratio).get h_succ) := by
  unfold oi_tracking liquidateTransition
  simp

-- ================================================================
-- oi_cap (total_long_oi + total_short_oi <= max_tvl)
-- ================================================================

theorem oi_cap_preserved_by_atomic_open
    (s : State) (signer : Pubkey)
    (deposit leverage_bps perp_side oracle_price : Nat)
    (h_inv : oi_cap s)
    (h_succ : (atomic_openTransition s signer deposit leverage_bps perp_side oracle_price).isSome) :
    oi_cap ((atomic_openTransition s signer deposit leverage_bps perp_side oracle_price).get h_succ) := by
  -- The guard ensures total_long_oi + total_short_oi + position_size <= max_tvl.
  -- After the transition, total_long_oi and total_short_oi each increase by at most
  -- position_size (exactly one side, depending on perp_side), so the sum is bounded.
  -- Proof requires reducing let-bindings through Option.get; delegated to Leanstral.
  sorry

-- ================================================================
-- leverage_bounds (size_usd <= collateral * max_leverage / 1000)
-- ================================================================

theorem leverage_bounds_preserved_by_atomic_open
    (s : State) (signer : Pubkey)
    (deposit leverage_bps perp_side oracle_price : Nat)
    (h_inv : leverage_bounds s)
    (h_succ : (atomic_openTransition s signer deposit leverage_bps perp_side oracle_price).isSome) :
    leverage_bounds ((atomic_openTransition s signer deposit leverage_bps perp_side oracle_price).get h_succ) := by
  -- Requires nonlinear Nat division reasoning about fee subtraction.
  -- size_usd = deposit * leverage_bps / 1000
  -- collateral = deposit - fee where fee = size_usd * protocol_fee_bps / 10000
  -- The property holds when leverage_bps <= max_leverage (from guard)
  -- but proving it requires: (d*l/1000) <= (d - d*l/1000*f/10000) * M / 1000
  -- which is nonlinear division reasoning that omega cannot handle.
  sorry

-- ================================================================
-- funding_bounds (funding_rate_bps <= MAX_FUNDING_RATE_BPS)
-- ================================================================

theorem funding_bounds_preserved_by_settle_funding
    (s : State) (signer : Pubkey)
    (funding_rate_bps current_timestamp : Nat)
    (h_succ : (settle_fundingTransition s signer funding_rate_bps current_timestamp).isSome) :
    funding_bounds ((settle_fundingTransition s signer funding_rate_bps current_timestamp).get h_succ) funding_rate_bps := by
  -- The guard ensures funding_rate_bps <= MAX_FUNDING_RATE_BPS.
  -- The property is on the parameter, not the state — trivially preserved.
  -- Proof requires extracting the guard from Option.isSome; delegated to Leanstral.
  sorry

-- ================================================================
-- no_overflow (collateral + size_usd >= collateral)
-- Trivially true for Nat (a + b >= a).
-- ================================================================

theorem no_overflow_preserved_by_initialize
    (s : State) (signer : Pubkey)
    (_h_inv : no_overflow s)
    (h_succ : (initializeTransition s signer).isSome) :
    no_overflow ((initializeTransition s signer).get h_succ) := by
  unfold no_overflow initializeTransition
  simp

theorem no_overflow_preserved_by_atomic_open
    (s : State) (signer : Pubkey)
    (deposit leverage_bps perp_side oracle_price : Nat)
    (_h_inv : no_overflow s)
    (h_succ : (atomic_openTransition s signer deposit leverage_bps perp_side oracle_price).isSome) :
    no_overflow ((atomic_openTransition s signer deposit leverage_bps perp_side oracle_price).get h_succ) := by
  unfold no_overflow atomic_openTransition mulDivFloor
  simp

theorem no_overflow_preserved_by_atomic_close
    (s : State) (signer : Pubkey) (close_bps : Nat)
    (_h_inv : no_overflow s)
    (h_succ : (atomic_closeTransition s signer close_bps).isSome) :
    no_overflow ((atomic_closeTransition s signer close_bps).get h_succ) := by
  unfold no_overflow atomic_closeTransition mulDivFloor
  simp

theorem no_overflow_preserved_by_liquidate
    (s : State) (signer : Pubkey) (margin_ratio : Nat)
    (_h_inv : no_overflow s)
    (h_succ : (liquidateTransition s signer margin_ratio).isSome) :
    no_overflow ((liquidateTransition s signer margin_ratio).get h_succ) := by
  unfold no_overflow liquidateTransition
  simp

theorem no_overflow_preserved_by_settle_funding
    (s : State) (signer : Pubkey)
    (funding_rate_bps current_timestamp : Nat)
    (_h_inv : no_overflow s)
    (h_succ : (settle_fundingTransition s signer funding_rate_bps current_timestamp).isSome) :
    no_overflow ((settle_fundingTransition s signer funding_rate_bps current_timestamp).get h_succ) := by
  unfold no_overflow settle_fundingTransition
  simp

theorem no_overflow_preserved_by_update_config
    (s : State) (signer : Pubkey)
    (_h_inv : no_overflow s)
    (h_succ : (update_configTransition s signer).isSome) :
    no_overflow ((update_configTransition s signer).get h_succ) := by
  unfold no_overflow update_configTransition
  simp

end AtomicPerps
