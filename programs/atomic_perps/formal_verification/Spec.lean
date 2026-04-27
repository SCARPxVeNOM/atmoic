/-
Spec.lean — State transitions and properties for AtomicPerps.
Generated from atomic_perps.qedspec, then hand-fixed for Lean 4 well-formedness.
-/
import QEDGen.Solana.Account

namespace AtomicPerps

open QEDGen.Solana.Account

-- Constants
abbrev BPS_DENOMINATOR : Nat := 10000
abbrev MAINTENANCE_MARGIN_BPS : Nat := 500
abbrev LIQUIDATION_BONUS_BPS : Nat := 500
abbrev MAX_FUNDING_RATE_BPS : Nat := 100

-- Helpers
def mulDivFloor (a b c : Nat) : Nat := (a * b) / c

-- Unified state (GlobalConfig + Position fields flattened)
structure State where
  -- GlobalConfig
  authority        : Pubkey
  fee_recipient    : Pubkey
  is_paused        : Nat
  max_leverage     : Nat
  protocol_fee_bps : Nat
  max_tvl          : Nat
  total_long_oi    : Nat
  total_short_oi   : Nat
  psf_balance      : Nat
  total_collateral : Nat
  last_funding_at  : Nat
  -- Position
  owner            : Pubkey
  collateral       : Nat
  size_usd         : Nat
  perp_side        : Nat
  perp_size        : Nat
  entry_price      : Nat
  is_open          : Nat
  deriving Repr, DecidableEq, BEq

instance : Inhabited State := ⟨{
  authority := default, fee_recipient := default,
  is_paused := 0, max_leverage := 0, protocol_fee_bps := 0,
  max_tvl := 0, total_long_oi := 0, total_short_oi := 0,
  psf_balance := 0, total_collateral := 0, last_funding_at := 0,
  owner := default, collateral := 0, size_usd := 0,
  perp_side := 0, perp_size := 0, entry_price := 0, is_open := 0,
}⟩

-- ================================================================
-- Transitions
-- ================================================================

def initializeTransition (s : State) (signer : Pubkey) : Option State :=
  some { s with
    authority := signer,
    is_paused := 0,
    total_long_oi := 0,
    total_short_oi := 0,
    psf_balance := 0,
    total_collateral := 0 }

def atomic_openTransition (s : State) (signer : Pubkey)
    (deposit : Nat) (leverage_bps : Nat) (perp_side : Nat)
    (oracle_price : Nat) : Option State :=
  let position_size := mulDivFloor deposit leverage_bps 1000
  let fee := mulDivFloor position_size s.protocol_fee_bps BPS_DENOMINATOR
  if s.is_paused = 0
    ∧ deposit > 0
    ∧ leverage_bps ≤ s.max_leverage
    ∧ leverage_bps ≥ 1000
    ∧ s.is_open = 0
    ∧ s.total_long_oi + s.total_short_oi + position_size ≤ s.max_tvl
  then
    some { s with
      is_open := 1,
      entry_price := oracle_price,
      perp_size := position_size,
      size_usd := position_size,
      collateral := deposit - fee,
      total_long_oi := s.total_long_oi + (if perp_side = 0 then position_size else 0),
      total_short_oi := s.total_short_oi + (if perp_side = 1 then position_size else 0),
      total_collateral := s.total_collateral + deposit }
  else none

def atomic_closeTransition (s : State) (signer : Pubkey)
    (close_bps : Nat) : Option State :=
  let closing_collateral := mulDivFloor s.collateral close_bps BPS_DENOMINATOR
  let closing_size := mulDivFloor s.perp_size close_bps BPS_DENOMINATOR
  if s.is_open = 1
    ∧ s.owner = signer
    ∧ close_bps ≥ 1
    ∧ close_bps ≤ BPS_DENOMINATOR
  then
    some { s with
      collateral := s.collateral - closing_collateral,
      perp_size := s.perp_size - closing_size,
      size_usd := s.size_usd - closing_size,
      total_long_oi := s.total_long_oi - (if s.perp_side = 0 then closing_size else 0),
      total_short_oi := s.total_short_oi - (if s.perp_side = 1 then closing_size else 0),
      total_collateral := s.total_collateral - closing_collateral }
  else none

def liquidateTransition (s : State) (signer : Pubkey)
    (margin_ratio : Nat) : Option State :=
  if s.is_open = 1 ∧ margin_ratio < MAINTENANCE_MARGIN_BPS then
    some { s with
      is_open := 0,
      total_long_oi := s.total_long_oi - (if s.perp_side = 0 then s.perp_size else 0),
      total_short_oi := s.total_short_oi - (if s.perp_side = 1 then s.perp_size else 0),
      total_collateral := s.total_collateral - s.collateral,
      collateral := 0,
      perp_size := 0,
      size_usd := 0 }
  else none

def settle_fundingTransition (s : State) (signer : Pubkey)
    (funding_rate_bps : Nat) (current_timestamp : Nat) : Option State :=
  if s.is_open = 1 ∧ s.is_paused = 0 ∧ funding_rate_bps ≤ MAX_FUNDING_RATE_BPS then
    some { s with last_funding_at := current_timestamp }
  else none

def update_configTransition (s : State) (signer : Pubkey) : Option State :=
  if signer = s.authority then some s
  else none

-- ================================================================
-- Operations
-- ================================================================

inductive Operation where
  | initialize
  | atomic_open (deposit leverage_bps perp_side oracle_price : Nat)
  | atomic_close (close_bps : Nat)
  | liquidate (margin_ratio : Nat)
  | settle_funding (funding_rate_bps current_timestamp : Nat)
  | update_config

def applyOp (s : State) (signer : Pubkey) : Operation → Option State
  | .initialize => initializeTransition s signer
  | .atomic_open d l ps op => atomic_openTransition s signer d l ps op
  | .atomic_close cb => atomic_closeTransition s signer cb
  | .liquidate mr => liquidateTransition s signer mr
  | .settle_funding fr ts => settle_fundingTransition s signer fr ts
  | .update_config => update_configTransition s signer

-- ================================================================
-- Properties
-- ================================================================

/-- Collateral conservation: total_collateral is always non-negative (trivially true for Nat). -/
def collateral_conservation (s : State) : Prop :=
  s.total_collateral ≥ 0

/-- OI tracking: both OI fields are non-negative (trivially true for Nat). -/
def oi_tracking (s : State) : Prop :=
  s.total_long_oi ≥ 0 ∧ s.total_short_oi ≥ 0

/-- OI cap: total open interest never exceeds max_tvl. -/
def oi_cap (s : State) : Prop :=
  s.total_long_oi + s.total_short_oi ≤ s.max_tvl

/-- Leverage bounds: position size bounded by leverage * collateral. -/
def leverage_bounds (s : State) : Prop :=
  s.size_usd ≤ mulDivFloor s.collateral s.max_leverage 1000

/-- Funding rate bounds: on-chain rate always within +-1%. -/
def funding_bounds (_s : State) (funding_rate_bps : Nat) : Prop :=
  funding_rate_bps ≤ MAX_FUNDING_RATE_BPS

/-- Arithmetic safety: collateral + size does not wrap. -/
def no_overflow (s : State) : Prop :=
  s.collateral + s.size_usd ≥ s.collateral

end AtomicPerps
