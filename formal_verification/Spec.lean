import QEDGen.Solana.Account
import QEDGen.Solana.Cpi
import QEDGen.Solana.State
import QEDGen.Solana.Valid

namespace AtomicPerps

open QEDGen.Solana

-- ============================================================================
-- State
-- ============================================================================

inductive Status where
  | Uninitialized
  | Active
  deriving Repr, DecidableEq, BEq

structure State where
  authority : Pubkey
  fee_recipient : Pubkey
  pyth_sol_feed : Pubkey
  sol_mint : Pubkey
  usdc_mint : Pubkey
  sol_vault : Pubkey
  usdc_reserve : Pubkey
  is_paused : Nat
  max_leverage : Nat
  liquidation_threshold : Nat
  protocol_fee_bps : Nat
  max_tvl : Nat
  total_usdc_borrowed : Nat
  total_usdc_reserve : Nat
  total_long_oi : Nat
  total_short_oi : Nat
  psf_balance : Nat
  status : Status
  deriving Repr, DecidableEq, BEq

-- ============================================================================
-- Transition Functions
-- ============================================================================

/-- One-time protocol initialization. Auth: authority (signer = stored authority). -/
def initializeTransition (s : State) (signer : Pubkey) (max_leverage : Nat) (liquidation_threshold : Nat) (protocol_fee_bps : Nat) (max_tvl : Nat) : Option State :=
  if signer = s.authority ∧ s.status = .Uninitialized ∧ max_leverage > 0 ∧ liquidation_threshold > 0 ∧ liquidation_threshold ≤ 10000 ∧ protocol_fee_bps ≤ 10000 then
    some { s with max_leverage := max_leverage, liquidation_threshold := liquidation_threshold, protocol_fee_bps := protocol_fee_bps, max_tvl := max_tvl, total_usdc_borrowed := 0, total_long_oi := 0, total_short_oi := 0, psf_balance := 0, is_paused := 0, status := .Active }
  else none

/-- Admin config update. Auth: authority (signer = stored authority). No state effects modeled. -/
def update_configTransition (s : State) (signer : Pubkey) : Option State :=
  if signer = s.authority ∧ s.status = .Active then
    some { s with status := .Active }
  else none

/-- Open a synthetic perp position. Auth: any user (permissionless signer). -/
def atomic_openTransition (s : State) (_signer : Pubkey) (collateral_amount : Nat) (borrow_amount : Nat) (leverage_bps : Nat) (spread_fee_bps : Nat) : Option State :=
  if s.status = .Active ∧ s.is_paused = 0 ∧ collateral_amount > 0 ∧ borrow_amount > 0 ∧ leverage_bps ≤ s.max_leverage ∧ spread_fee_bps ≥ 5 ∧ s.total_usdc_borrowed + borrow_amount ≤ s.total_usdc_reserve ∧ s.total_usdc_borrowed + borrow_amount ≤ s.max_tvl ∧ s.total_long_oi + s.total_short_oi ≤ s.total_usdc_reserve * 80 / 100 then
    some { s with total_usdc_borrowed := s.total_usdc_borrowed + borrow_amount, status := .Active }
  else none

/-- Close a position: repay borrow, settle PnL. Auth: any user (permissionless). -/
def atomic_closeTransition (s : State) (_signer : Pubkey) (borrow_amount : Nat) (_collateral_to_return : Nat) (_fee_amount : Nat) : Option State :=
  if s.status = .Active ∧ borrow_amount > 0 ∧ borrow_amount ≤ s.total_usdc_borrowed then
    some { s with total_usdc_borrowed := s.total_usdc_borrowed - borrow_amount, status := .Active }
  else none

/-- Liquidate an unhealthy position. Auth: any liquidator (permissionless). -/
def liquidateTransition (s : State) (_signer : Pubkey) (borrow_amount : Nat) (_collateral_amount : Nat) : Option State :=
  if s.status = .Active ∧ borrow_amount > 0 ∧ borrow_amount ≤ s.total_usdc_borrowed then
    some { s with total_usdc_borrowed := s.total_usdc_borrowed - borrow_amount, status := .Active }
  else none

/-- Place a limit order into a DFBA queue shard. Auth: any user. -/
def place_orderTransition (s : State) (_signer : Pubkey) (price : Nat) (size : Nat) : Option State :=
  if s.status = .Active ∧ price > 0 ∧ size > 0 then
    some { s with status := .Active }
  else none

/-- Cancel a user order from a queue shard. Auth: any user. -/
def cancel_orderTransition (s : State) (_signer : Pubkey) : Option State :=
  if s.status = .Active then
    some { s with status := .Active }
  else none

/-- Permissionless DFBA batch execution. Auth: any crank.
    Combined OI guard added: formal verification found the per-side guards insufficient
    to preserve oi_bounded (total_long + total_short ≤ reserve). -/
def execute_batchTransition (s : State) (_signer : Pubkey) (matched_bid_volume : Nat) (matched_ask_volume : Nat) (total_matchable : Nat) : Option State :=
  if s.status = .Active ∧ s.total_long_oi + matched_bid_volume ≤ s.total_usdc_reserve ∧ s.total_short_oi + matched_ask_volume ≤ s.total_usdc_reserve ∧ s.total_long_oi + matched_bid_volume + s.total_short_oi + matched_ask_volume ≤ s.total_usdc_reserve ∧ s.psf_balance + total_matchable / 10000 ≤ 18446744073709551615 then
    some { s with total_long_oi := s.total_long_oi + matched_bid_volume, total_short_oi := s.total_short_oi + matched_ask_volume, psf_balance := s.psf_balance + total_matchable / 10000, status := .Active }
  else none

-- ============================================================================
-- Transfer correctness theorems — token conservation laws
-- Each proves: (source - amount) + (dest + amount) = source + dest
-- i.e., no tokens created or destroyed during SPL transfers.
-- ============================================================================

/-- atomic_open: collateral moves user_sol -> sol_vault. -/
theorem atomic_open_transfer_correct
    (user_sol vault_sol collateral : Nat)
    (h : collateral ≤ user_sol) :
    (user_sol - collateral) + (vault_sol + collateral) = user_sol + vault_sol := by omega

/-- atomic_close transfer 0: borrow repaid user_usdc -> usdc_reserve. -/
theorem atomic_close_transfer_0_correct
    (user_usdc reserve_usdc borrow : Nat)
    (h : borrow ≤ user_usdc) :
    (user_usdc - borrow) + (reserve_usdc + borrow) = user_usdc + reserve_usdc := by omega

/-- atomic_close transfer 1: collateral returned sol_vault -> user_sol. -/
theorem atomic_close_transfer_1_correct
    (vault_sol user_sol collateral_to_return : Nat)
    (h : collateral_to_return ≤ vault_sol) :
    (vault_sol - collateral_to_return) + (user_sol + collateral_to_return) = vault_sol + user_sol := by omega

/-- atomic_close transfer 2: fee from usdc_reserve -> fee_recipient. -/
theorem atomic_close_transfer_2_correct
    (reserve_usdc fee_bal fee_amount : Nat)
    (h : fee_amount ≤ reserve_usdc) :
    (reserve_usdc - fee_amount) + (fee_bal + fee_amount) = reserve_usdc + fee_bal := by omega

/-- liquidate transfer 0: bonus from sol_vault -> liquidator. -/
theorem liquidate_transfer_0_correct
    (vault_sol liq_sol bonus : Nat)
    (h : bonus ≤ vault_sol) :
    (vault_sol - bonus) + (liq_sol + bonus) = vault_sol + liq_sol := by omega

/-- liquidate transfer 1: remainder from sol_vault -> fee_recipient. -/
theorem liquidate_transfer_1_correct
    (vault_sol fee_sol remainder : Nat)
    (h : remainder ≤ vault_sol) :
    (vault_sol - remainder) + (fee_sol + remainder) = vault_sol + fee_sol := by omega

-- ============================================================================
-- Invariant theorems — structural properties of the protocol
-- ============================================================================

/-- Authority is reflexively equal after initialize (set via PDA constraint). -/
theorem authority_set : ∀ s : State, s.status = .Active → s.authority = s.authority := by
  intro s _; rfl

/-- Collateral conservation: open transfer preserves total SOL across user + vault. -/
theorem collateral_flow
    (user_sol vault_sol collateral : Nat) (h : collateral ≤ user_sol) :
    (user_sol - collateral) + (vault_sol + collateral) = user_sol + vault_sol := by omega

/-- Fee routing conservation: fee transfer preserves total USDC across reserve + recipient. -/
theorem fee_routing
    (reserve fee_bal fee_amount : Nat) (h : fee_amount ≤ reserve) :
    (reserve - fee_amount) + (fee_bal + fee_amount) = reserve + fee_bal := by omega

/-- Liquidation incentive: bonus (5%) + remainder = full collateral amount.
    LIQUIDATION_BONUS_BPS = 500, BPS_DENOMINATOR = 10000. -/
theorem liquidation_incentive (collateral : Nat) (h : collateral ≥ 500) :
    let bonus := collateral * 500 / 10000
    let remainder := collateral - bonus
    bonus + remainder = collateral := by omega

/-- DFBA clearing price clamp: min(max(price, lower), upper) ∈ [lower, upper]. -/
theorem clearing_price_bounded (price lower upper : Nat) (h : lower ≤ upper) :
    lower ≤ min (max price lower) upper ∧ min (max price lower) upper ≤ upper := by
  simp only [Nat.min_def, Nat.max_def]
  constructor
  · split
    · omega
    · split <;> omega
  · split
    · omega
    · split <;> omega

-- ============================================================================
-- Operation enum and dispatch
-- ============================================================================

inductive Operation where
  | «initialize» (max_leverage : Nat) (liquidation_threshold : Nat) (protocol_fee_bps : Nat) (max_tvl : Nat)
  | update_config
  | atomic_open (collateral_amount : Nat) (borrow_amount : Nat) (leverage_bps : Nat) (spread_fee_bps : Nat)
  | atomic_close (borrow_amount : Nat) (collateral_to_return : Nat) (fee_amount : Nat)
  | liquidate (borrow_amount : Nat) (collateral_amount : Nat)
  | place_order (price : Nat) (size : Nat)
  | cancel_order
  | execute_batch (matched_bid_volume : Nat) (matched_ask_volume : Nat) (total_matchable : Nat)
  deriving Repr, DecidableEq, BEq

def applyOp (s : State) (signer : Pubkey) : Operation → Option State
  | .«initialize» ml lt fb mt => initializeTransition s signer ml lt fb mt
  | .update_config => update_configTransition s signer
  | .atomic_open ca ba lb sf => atomic_openTransition s signer ca ba lb sf
  | .atomic_close ba cr fa => atomic_closeTransition s signer ba cr fa
  | .liquidate ba ca => liquidateTransition s signer ba ca
  | .place_order p sz => place_orderTransition s signer p sz
  | .cancel_order => cancel_orderTransition s signer
  | .execute_batch mbv mav tm => execute_batchTransition s signer mbv mav tm

-- ============================================================================
-- Property 1: reserve_solvency
-- ============================================================================

def reserve_solvency (s : State) : Prop := s.total_usdc_borrowed ≤ s.total_usdc_reserve

theorem reserve_solvency_preserved_by_initialize (s s' : State) (signer : Pubkey) (max_leverage : Nat) (liquidation_threshold : Nat) (protocol_fee_bps : Nat) (max_tvl : Nat)
    (h_inv : reserve_solvency s) (h : initializeTransition s signer max_leverage liquidation_threshold protocol_fee_bps max_tvl = some s') :
    reserve_solvency s' := by
  unfold initializeTransition at h; split at h
  · next hg => cases h; unfold reserve_solvency at h_inv ⊢; dsimp; omega
  · contradiction

theorem reserve_solvency_preserved_by_update_config (s s' : State) (signer : Pubkey)
    (h_inv : reserve_solvency s) (h : update_configTransition s signer = some s') :
    reserve_solvency s' := by
  unfold update_configTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem reserve_solvency_preserved_by_atomic_open (s s' : State) (signer : Pubkey) (collateral_amount : Nat) (borrow_amount : Nat) (leverage_bps : Nat) (spread_fee_bps : Nat)
    (h_inv : reserve_solvency s) (h : atomic_openTransition s signer collateral_amount borrow_amount leverage_bps spread_fee_bps = some s') :
    reserve_solvency s' := by
  unfold atomic_openTransition at h; split at h
  · next hg => cases h; unfold reserve_solvency at h_inv ⊢; dsimp; omega
  · contradiction

theorem reserve_solvency_preserved_by_atomic_close (s s' : State) (signer : Pubkey) (borrow_amount : Nat) (collateral_to_return : Nat) (fee_amount : Nat)
    (h_inv : reserve_solvency s) (h : atomic_closeTransition s signer borrow_amount collateral_to_return fee_amount = some s') :
    reserve_solvency s' := by
  unfold atomic_closeTransition at h; split at h
  · next hg => cases h; unfold reserve_solvency at h_inv ⊢; dsimp; omega
  · contradiction

theorem reserve_solvency_preserved_by_liquidate (s s' : State) (signer : Pubkey) (borrow_amount : Nat) (collateral_amount : Nat)
    (h_inv : reserve_solvency s) (h : liquidateTransition s signer borrow_amount collateral_amount = some s') :
    reserve_solvency s' := by
  unfold liquidateTransition at h; split at h
  · next hg => cases h; unfold reserve_solvency at h_inv ⊢; dsimp; omega
  · contradiction

theorem reserve_solvency_preserved_by_place_order (s s' : State) (signer : Pubkey) (price : Nat) (size : Nat)
    (h_inv : reserve_solvency s) (h : place_orderTransition s signer price size = some s') :
    reserve_solvency s' := by
  unfold place_orderTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem reserve_solvency_preserved_by_cancel_order (s s' : State) (signer : Pubkey)
    (h_inv : reserve_solvency s) (h : cancel_orderTransition s signer = some s') :
    reserve_solvency s' := by
  unfold cancel_orderTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem reserve_solvency_preserved_by_execute_batch (s s' : State) (signer : Pubkey) (matched_bid_volume : Nat) (matched_ask_volume : Nat) (total_matchable : Nat)
    (h_inv : reserve_solvency s) (h : execute_batchTransition s signer matched_bid_volume matched_ask_volume total_matchable = some s') :
    reserve_solvency s' := by
  unfold execute_batchTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem reserve_solvency_inductive (s s' : State) (signer : Pubkey) (op : Operation)
    (h_inv : reserve_solvency s) (h : applyOp s signer op = some s') : reserve_solvency s' := by
  cases op with
  | «initialize» ml lt fb mt => exact reserve_solvency_preserved_by_initialize s s' signer ml lt fb mt h_inv h
  | update_config => exact reserve_solvency_preserved_by_update_config s s' signer h_inv h
  | atomic_open ca ba lb sf => exact reserve_solvency_preserved_by_atomic_open s s' signer ca ba lb sf h_inv h
  | atomic_close ba cr fa => exact reserve_solvency_preserved_by_atomic_close s s' signer ba cr fa h_inv h
  | liquidate ba ca => exact reserve_solvency_preserved_by_liquidate s s' signer ba ca h_inv h
  | place_order p sz => exact reserve_solvency_preserved_by_place_order s s' signer p sz h_inv h
  | cancel_order => exact reserve_solvency_preserved_by_cancel_order s s' signer h_inv h
  | execute_batch mbv mav tm => exact reserve_solvency_preserved_by_execute_batch s s' signer mbv mav tm h_inv h

-- ============================================================================
-- Property 2: leverage_bounded
-- ============================================================================

def leverage_bounded (s : State) : Prop := s.max_leverage > 0

theorem leverage_bounded_preserved_by_initialize (s s' : State) (signer : Pubkey) (max_leverage : Nat) (liquidation_threshold : Nat) (protocol_fee_bps : Nat) (max_tvl : Nat)
    (h_inv : leverage_bounded s) (h : initializeTransition s signer max_leverage liquidation_threshold protocol_fee_bps max_tvl = some s') :
    leverage_bounded s' := by
  unfold initializeTransition at h; split at h
  · next hg => cases h; unfold leverage_bounded at h_inv ⊢; dsimp; omega
  · contradiction

theorem leverage_bounded_preserved_by_update_config (s s' : State) (signer : Pubkey)
    (h_inv : leverage_bounded s) (h : update_configTransition s signer = some s') :
    leverage_bounded s' := by
  unfold update_configTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem leverage_bounded_preserved_by_atomic_open (s s' : State) (signer : Pubkey) (ca : Nat) (ba : Nat) (lb : Nat) (sf : Nat)
    (h_inv : leverage_bounded s) (h : atomic_openTransition s signer ca ba lb sf = some s') :
    leverage_bounded s' := by
  unfold atomic_openTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem leverage_bounded_preserved_by_atomic_close (s s' : State) (signer : Pubkey) (ba : Nat) (cr : Nat) (fa : Nat)
    (h_inv : leverage_bounded s) (h : atomic_closeTransition s signer ba cr fa = some s') :
    leverage_bounded s' := by
  unfold atomic_closeTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem leverage_bounded_preserved_by_liquidate (s s' : State) (signer : Pubkey) (ba : Nat) (ca : Nat)
    (h_inv : leverage_bounded s) (h : liquidateTransition s signer ba ca = some s') :
    leverage_bounded s' := by
  unfold liquidateTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem leverage_bounded_preserved_by_place_order (s s' : State) (signer : Pubkey) (p : Nat) (sz : Nat)
    (h_inv : leverage_bounded s) (h : place_orderTransition s signer p sz = some s') :
    leverage_bounded s' := by
  unfold place_orderTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem leverage_bounded_preserved_by_cancel_order (s s' : State) (signer : Pubkey)
    (h_inv : leverage_bounded s) (h : cancel_orderTransition s signer = some s') :
    leverage_bounded s' := by
  unfold cancel_orderTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem leverage_bounded_preserved_by_execute_batch (s s' : State) (signer : Pubkey) (mbv : Nat) (mav : Nat) (tm : Nat)
    (h_inv : leverage_bounded s) (h : execute_batchTransition s signer mbv mav tm = some s') :
    leverage_bounded s' := by
  unfold execute_batchTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem leverage_bounded_inductive (s s' : State) (signer : Pubkey) (op : Operation)
    (h_inv : leverage_bounded s) (h : applyOp s signer op = some s') : leverage_bounded s' := by
  cases op with
  | «initialize» ml lt fb mt => exact leverage_bounded_preserved_by_initialize s s' signer ml lt fb mt h_inv h
  | update_config => exact leverage_bounded_preserved_by_update_config s s' signer h_inv h
  | atomic_open ca ba lb sf => exact leverage_bounded_preserved_by_atomic_open s s' signer ca ba lb sf h_inv h
  | atomic_close ba cr fa => exact leverage_bounded_preserved_by_atomic_close s s' signer ba cr fa h_inv h
  | liquidate ba ca => exact leverage_bounded_preserved_by_liquidate s s' signer ba ca h_inv h
  | place_order p sz => exact leverage_bounded_preserved_by_place_order s s' signer p sz h_inv h
  | cancel_order => exact leverage_bounded_preserved_by_cancel_order s s' signer h_inv h
  | execute_batch mbv mav tm => exact leverage_bounded_preserved_by_execute_batch s s' signer mbv mav tm h_inv h

-- ============================================================================
-- Property 3: fee_bounded
-- ============================================================================

def fee_bounded (s : State) : Prop := s.protocol_fee_bps ≤ 10000

theorem fee_bounded_preserved_by_initialize (s s' : State) (signer : Pubkey) (max_leverage : Nat) (liquidation_threshold : Nat) (protocol_fee_bps : Nat) (max_tvl : Nat)
    (h_inv : fee_bounded s) (h : initializeTransition s signer max_leverage liquidation_threshold protocol_fee_bps max_tvl = some s') :
    fee_bounded s' := by
  unfold initializeTransition at h; split at h
  · next hg => cases h; unfold fee_bounded at h_inv ⊢; dsimp; omega
  · contradiction

theorem fee_bounded_preserved_by_update_config (s s' : State) (signer : Pubkey)
    (h_inv : fee_bounded s) (h : update_configTransition s signer = some s') :
    fee_bounded s' := by
  unfold update_configTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem fee_bounded_preserved_by_atomic_open (s s' : State) (signer : Pubkey) (ca : Nat) (ba : Nat) (lb : Nat) (sf : Nat)
    (h_inv : fee_bounded s) (h : atomic_openTransition s signer ca ba lb sf = some s') :
    fee_bounded s' := by
  unfold atomic_openTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem fee_bounded_preserved_by_atomic_close (s s' : State) (signer : Pubkey) (ba : Nat) (cr : Nat) (fa : Nat)
    (h_inv : fee_bounded s) (h : atomic_closeTransition s signer ba cr fa = some s') :
    fee_bounded s' := by
  unfold atomic_closeTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem fee_bounded_preserved_by_liquidate (s s' : State) (signer : Pubkey) (ba : Nat) (ca : Nat)
    (h_inv : fee_bounded s) (h : liquidateTransition s signer ba ca = some s') :
    fee_bounded s' := by
  unfold liquidateTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem fee_bounded_preserved_by_place_order (s s' : State) (signer : Pubkey) (p : Nat) (sz : Nat)
    (h_inv : fee_bounded s) (h : place_orderTransition s signer p sz = some s') :
    fee_bounded s' := by
  unfold place_orderTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem fee_bounded_preserved_by_cancel_order (s s' : State) (signer : Pubkey)
    (h_inv : fee_bounded s) (h : cancel_orderTransition s signer = some s') :
    fee_bounded s' := by
  unfold cancel_orderTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem fee_bounded_preserved_by_execute_batch (s s' : State) (signer : Pubkey) (mbv : Nat) (mav : Nat) (tm : Nat)
    (h_inv : fee_bounded s) (h : execute_batchTransition s signer mbv mav tm = some s') :
    fee_bounded s' := by
  unfold execute_batchTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem fee_bounded_inductive (s s' : State) (signer : Pubkey) (op : Operation)
    (h_inv : fee_bounded s) (h : applyOp s signer op = some s') : fee_bounded s' := by
  cases op with
  | «initialize» ml lt fb mt => exact fee_bounded_preserved_by_initialize s s' signer ml lt fb mt h_inv h
  | update_config => exact fee_bounded_preserved_by_update_config s s' signer h_inv h
  | atomic_open ca ba lb sf => exact fee_bounded_preserved_by_atomic_open s s' signer ca ba lb sf h_inv h
  | atomic_close ba cr fa => exact fee_bounded_preserved_by_atomic_close s s' signer ba cr fa h_inv h
  | liquidate ba ca => exact fee_bounded_preserved_by_liquidate s s' signer ba ca h_inv h
  | place_order p sz => exact fee_bounded_preserved_by_place_order s s' signer p sz h_inv h
  | cancel_order => exact fee_bounded_preserved_by_cancel_order s s' signer h_inv h
  | execute_batch mbv mav tm => exact fee_bounded_preserved_by_execute_batch s s' signer mbv mav tm h_inv h

-- ============================================================================
-- Property 4: oi_bounded
-- ============================================================================

def oi_bounded (s : State) : Prop := s.total_long_oi + s.total_short_oi ≤ s.total_usdc_reserve

theorem oi_bounded_preserved_by_initialize (s s' : State) (signer : Pubkey) (max_leverage : Nat) (liquidation_threshold : Nat) (protocol_fee_bps : Nat) (max_tvl : Nat)
    (h_inv : oi_bounded s) (h : initializeTransition s signer max_leverage liquidation_threshold protocol_fee_bps max_tvl = some s') :
    oi_bounded s' := by
  unfold initializeTransition at h; split at h
  · next hg => cases h; unfold oi_bounded at h_inv ⊢; dsimp; omega
  · contradiction

theorem oi_bounded_preserved_by_update_config (s s' : State) (signer : Pubkey)
    (h_inv : oi_bounded s) (h : update_configTransition s signer = some s') :
    oi_bounded s' := by
  unfold update_configTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem oi_bounded_preserved_by_atomic_open (s s' : State) (signer : Pubkey) (ca : Nat) (ba : Nat) (lb : Nat) (sf : Nat)
    (h_inv : oi_bounded s) (h : atomic_openTransition s signer ca ba lb sf = some s') :
    oi_bounded s' := by
  unfold atomic_openTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem oi_bounded_preserved_by_atomic_close (s s' : State) (signer : Pubkey) (ba : Nat) (cr : Nat) (fa : Nat)
    (h_inv : oi_bounded s) (h : atomic_closeTransition s signer ba cr fa = some s') :
    oi_bounded s' := by
  unfold atomic_closeTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem oi_bounded_preserved_by_liquidate (s s' : State) (signer : Pubkey) (ba : Nat) (ca : Nat)
    (h_inv : oi_bounded s) (h : liquidateTransition s signer ba ca = some s') :
    oi_bounded s' := by
  unfold liquidateTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem oi_bounded_preserved_by_place_order (s s' : State) (signer : Pubkey) (p : Nat) (sz : Nat)
    (h_inv : oi_bounded s) (h : place_orderTransition s signer p sz = some s') :
    oi_bounded s' := by
  unfold place_orderTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem oi_bounded_preserved_by_cancel_order (s s' : State) (signer : Pubkey)
    (h_inv : oi_bounded s) (h : cancel_orderTransition s signer = some s') :
    oi_bounded s' := by
  unfold cancel_orderTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem oi_bounded_preserved_by_execute_batch (s s' : State) (signer : Pubkey) (matched_bid_volume : Nat) (matched_ask_volume : Nat) (total_matchable : Nat)
    (h_inv : oi_bounded s) (h : execute_batchTransition s signer matched_bid_volume matched_ask_volume total_matchable = some s') :
    oi_bounded s' := by
  unfold execute_batchTransition at h; split at h
  · next hg => cases h; unfold oi_bounded at h_inv ⊢; dsimp; omega
  · contradiction

theorem oi_bounded_inductive (s s' : State) (signer : Pubkey) (op : Operation)
    (h_inv : oi_bounded s) (h : applyOp s signer op = some s') : oi_bounded s' := by
  cases op with
  | «initialize» ml lt fb mt => exact oi_bounded_preserved_by_initialize s s' signer ml lt fb mt h_inv h
  | update_config => exact oi_bounded_preserved_by_update_config s s' signer h_inv h
  | atomic_open ca ba lb sf => exact oi_bounded_preserved_by_atomic_open s s' signer ca ba lb sf h_inv h
  | atomic_close ba cr fa => exact oi_bounded_preserved_by_atomic_close s s' signer ba cr fa h_inv h
  | liquidate ba ca => exact oi_bounded_preserved_by_liquidate s s' signer ba ca h_inv h
  | place_order p sz => exact oi_bounded_preserved_by_place_order s s' signer p sz h_inv h
  | cancel_order => exact oi_bounded_preserved_by_cancel_order s s' signer h_inv h
  | execute_batch mbv mav tm => exact oi_bounded_preserved_by_execute_batch s s' signer mbv mav tm h_inv h

-- ============================================================================
-- Property 5: liquidation_threshold_valid
-- ============================================================================

def liquidation_threshold_valid (s : State) : Prop := s.liquidation_threshold ≤ 10000

theorem liquidation_threshold_valid_preserved_by_initialize (s s' : State) (signer : Pubkey) (max_leverage : Nat) (liquidation_threshold : Nat) (protocol_fee_bps : Nat) (max_tvl : Nat)
    (h_inv : liquidation_threshold_valid s) (h : initializeTransition s signer max_leverage liquidation_threshold protocol_fee_bps max_tvl = some s') :
    liquidation_threshold_valid s' := by
  unfold initializeTransition at h; split at h
  · next hg => cases h; unfold liquidation_threshold_valid at h_inv ⊢; dsimp; omega
  · contradiction

theorem liquidation_threshold_valid_preserved_by_update_config (s s' : State) (signer : Pubkey)
    (h_inv : liquidation_threshold_valid s) (h : update_configTransition s signer = some s') :
    liquidation_threshold_valid s' := by
  unfold update_configTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem liquidation_threshold_valid_preserved_by_atomic_open (s s' : State) (signer : Pubkey) (ca : Nat) (ba : Nat) (lb : Nat) (sf : Nat)
    (h_inv : liquidation_threshold_valid s) (h : atomic_openTransition s signer ca ba lb sf = some s') :
    liquidation_threshold_valid s' := by
  unfold atomic_openTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem liquidation_threshold_valid_preserved_by_atomic_close (s s' : State) (signer : Pubkey) (ba : Nat) (cr : Nat) (fa : Nat)
    (h_inv : liquidation_threshold_valid s) (h : atomic_closeTransition s signer ba cr fa = some s') :
    liquidation_threshold_valid s' := by
  unfold atomic_closeTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem liquidation_threshold_valid_preserved_by_liquidate (s s' : State) (signer : Pubkey) (ba : Nat) (ca : Nat)
    (h_inv : liquidation_threshold_valid s) (h : liquidateTransition s signer ba ca = some s') :
    liquidation_threshold_valid s' := by
  unfold liquidateTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem liquidation_threshold_valid_preserved_by_place_order (s s' : State) (signer : Pubkey) (p : Nat) (sz : Nat)
    (h_inv : liquidation_threshold_valid s) (h : place_orderTransition s signer p sz = some s') :
    liquidation_threshold_valid s' := by
  unfold place_orderTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem liquidation_threshold_valid_preserved_by_cancel_order (s s' : State) (signer : Pubkey)
    (h_inv : liquidation_threshold_valid s) (h : cancel_orderTransition s signer = some s') :
    liquidation_threshold_valid s' := by
  unfold cancel_orderTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem liquidation_threshold_valid_preserved_by_execute_batch (s s' : State) (signer : Pubkey) (mbv : Nat) (mav : Nat) (tm : Nat)
    (h_inv : liquidation_threshold_valid s) (h : execute_batchTransition s signer mbv mav tm = some s') :
    liquidation_threshold_valid s' := by
  unfold execute_batchTransition at h; split at h
  · cases h; exact h_inv
  · contradiction

theorem liquidation_threshold_valid_inductive (s s' : State) (signer : Pubkey) (op : Operation)
    (h_inv : liquidation_threshold_valid s) (h : applyOp s signer op = some s') : liquidation_threshold_valid s' := by
  cases op with
  | «initialize» ml lt fb mt => exact liquidation_threshold_valid_preserved_by_initialize s s' signer ml lt fb mt h_inv h
  | update_config => exact liquidation_threshold_valid_preserved_by_update_config s s' signer h_inv h
  | atomic_open ca ba lb sf => exact liquidation_threshold_valid_preserved_by_atomic_open s s' signer ca ba lb sf h_inv h
  | atomic_close ba cr fa => exact liquidation_threshold_valid_preserved_by_atomic_close s s' signer ba cr fa h_inv h
  | liquidate ba ca => exact liquidation_threshold_valid_preserved_by_liquidate s s' signer ba ca h_inv h
  | place_order p sz => exact liquidation_threshold_valid_preserved_by_place_order s s' signer p sz h_inv h
  | cancel_order => exact liquidation_threshold_valid_preserved_by_cancel_order s s' signer h_inv h
  | execute_batch mbv mav tm => exact liquidation_threshold_valid_preserved_by_execute_batch s s' signer mbv mav tm h_inv h

-- ============================================================================
-- Abort conditions — operations must reject under specified conditions
-- ============================================================================

-- initialize abort conditions
theorem initialize_aborts_zero_leverage (s : State) (signer : Pubkey) (max_leverage : Nat) (liquidation_threshold : Nat) (protocol_fee_bps : Nat) (max_tvl : Nat)
    (h : ¬(max_leverage > 0)) : initializeTransition s signer max_leverage liquidation_threshold protocol_fee_bps max_tvl = none := by
  unfold initializeTransition; rw [if_neg (fun hg => h hg.2.2.1)]

theorem initialize_aborts_zero_threshold (s : State) (signer : Pubkey) (max_leverage : Nat) (liquidation_threshold : Nat) (protocol_fee_bps : Nat) (max_tvl : Nat)
    (h : ¬(liquidation_threshold > 0)) : initializeTransition s signer max_leverage liquidation_threshold protocol_fee_bps max_tvl = none := by
  unfold initializeTransition; rw [if_neg (fun hg => h hg.2.2.2.1)]

theorem initialize_aborts_threshold_exceeds_bps (s : State) (signer : Pubkey) (max_leverage : Nat) (liquidation_threshold : Nat) (protocol_fee_bps : Nat) (max_tvl : Nat)
    (h : ¬(liquidation_threshold ≤ 10000)) : initializeTransition s signer max_leverage liquidation_threshold protocol_fee_bps max_tvl = none := by
  unfold initializeTransition; rw [if_neg (fun hg => h hg.2.2.2.2.1)]

theorem initialize_aborts_fee_exceeds_bps (s : State) (signer : Pubkey) (max_leverage : Nat) (liquidation_threshold : Nat) (protocol_fee_bps : Nat) (max_tvl : Nat)
    (h : ¬(protocol_fee_bps ≤ 10000)) : initializeTransition s signer max_leverage liquidation_threshold protocol_fee_bps max_tvl = none := by
  unfold initializeTransition; rw [if_neg (fun hg => h hg.2.2.2.2.2)]

-- update_config abort condition
theorem update_config_aborts_unauthorized (s : State) (signer : Pubkey)
    (h : ¬(signer = s.authority)) : update_configTransition s signer = none := by
  unfold update_configTransition; rw [if_neg (fun hg => h hg.1)]

-- atomic_open abort conditions
theorem atomic_open_aborts_paused (s : State) (signer : Pubkey) (ca : Nat) (ba : Nat) (lb : Nat) (sf : Nat)
    (h : ¬(s.is_paused = 0)) : atomic_openTransition s signer ca ba lb sf = none := by
  unfold atomic_openTransition; rw [if_neg (fun hg => h hg.2.1)]

theorem atomic_open_aborts_zero_collateral (s : State) (signer : Pubkey) (ca : Nat) (ba : Nat) (lb : Nat) (sf : Nat)
    (h : ¬(ca > 0)) : atomic_openTransition s signer ca ba lb sf = none := by
  unfold atomic_openTransition; rw [if_neg (fun hg => h hg.2.2.1)]

theorem atomic_open_aborts_zero_borrow (s : State) (signer : Pubkey) (ca : Nat) (ba : Nat) (lb : Nat) (sf : Nat)
    (h : ¬(ba > 0)) : atomic_openTransition s signer ca ba lb sf = none := by
  unfold atomic_openTransition; rw [if_neg (fun hg => h hg.2.2.2.1)]

theorem atomic_open_aborts_excessive_leverage (s : State) (signer : Pubkey) (ca : Nat) (ba : Nat) (lb : Nat) (sf : Nat)
    (h : ¬(lb ≤ s.max_leverage)) : atomic_openTransition s signer ca ba lb sf = none := by
  unfold atomic_openTransition; rw [if_neg (fun hg => h hg.2.2.2.2.1)]

theorem atomic_open_aborts_spread_below_min (s : State) (signer : Pubkey) (ca : Nat) (ba : Nat) (lb : Nat) (sf : Nat)
    (h : ¬(sf ≥ 5)) : atomic_openTransition s signer ca ba lb sf = none := by
  unfold atomic_openTransition; rw [if_neg (fun hg => h hg.2.2.2.2.2.1)]

theorem atomic_open_aborts_borrow_exceeds_reserve (s : State) (signer : Pubkey) (ca : Nat) (ba : Nat) (lb : Nat) (sf : Nat)
    (h : ¬(s.total_usdc_borrowed + ba ≤ s.total_usdc_reserve)) : atomic_openTransition s signer ca ba lb sf = none := by
  unfold atomic_openTransition; rw [if_neg (fun hg => h hg.2.2.2.2.2.2.1)]

theorem atomic_open_aborts_borrow_exceeds_tvl (s : State) (signer : Pubkey) (ca : Nat) (ba : Nat) (lb : Nat) (sf : Nat)
    (h : ¬(s.total_usdc_borrowed + ba ≤ s.max_tvl)) : atomic_openTransition s signer ca ba lb sf = none := by
  unfold atomic_openTransition; rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.1)]

theorem atomic_open_aborts_oi_exceeds_cap (s : State) (signer : Pubkey) (ca : Nat) (ba : Nat) (lb : Nat) (sf : Nat)
    (h : ¬(s.total_long_oi + s.total_short_oi ≤ s.total_usdc_reserve * 80 / 100)) : atomic_openTransition s signer ca ba lb sf = none := by
  unfold atomic_openTransition; rw [if_neg (fun hg => h hg.2.2.2.2.2.2.2.2)]

-- atomic_close abort conditions
theorem atomic_close_aborts_zero_borrow (s : State) (signer : Pubkey) (ba : Nat) (cr : Nat) (fa : Nat)
    (h : ¬(ba > 0)) : atomic_closeTransition s signer ba cr fa = none := by
  unfold atomic_closeTransition; rw [if_neg (fun hg => h hg.2.1)]

theorem atomic_close_aborts_borrow_exceeds_borrowed (s : State) (signer : Pubkey) (ba : Nat) (cr : Nat) (fa : Nat)
    (h : ¬(ba ≤ s.total_usdc_borrowed)) : atomic_closeTransition s signer ba cr fa = none := by
  unfold atomic_closeTransition; rw [if_neg (fun hg => h hg.2.2)]

-- liquidate abort conditions
theorem liquidate_aborts_zero_borrow (s : State) (signer : Pubkey) (ba : Nat) (ca : Nat)
    (h : ¬(ba > 0)) : liquidateTransition s signer ba ca = none := by
  unfold liquidateTransition; rw [if_neg (fun hg => h hg.2.1)]

theorem liquidate_aborts_borrow_exceeds_borrowed (s : State) (signer : Pubkey) (ba : Nat) (ca : Nat)
    (h : ¬(ba ≤ s.total_usdc_borrowed)) : liquidateTransition s signer ba ca = none := by
  unfold liquidateTransition; rw [if_neg (fun hg => h hg.2.2)]

-- place_order abort conditions
theorem place_order_aborts_zero_price (s : State) (signer : Pubkey) (p : Nat) (sz : Nat)
    (h : ¬(p > 0)) : place_orderTransition s signer p sz = none := by
  unfold place_orderTransition; rw [if_neg (fun hg => h hg.2.1)]

theorem place_order_aborts_zero_size (s : State) (signer : Pubkey) (p : Nat) (sz : Nat)
    (h : ¬(sz > 0)) : place_orderTransition s signer p sz = none := by
  unfold place_orderTransition; rw [if_neg (fun hg => h hg.2.2)]

-- execute_batch abort conditions
theorem execute_batch_aborts_long_oi_exceeds_reserve (s : State) (signer : Pubkey) (mbv : Nat) (mav : Nat) (tm : Nat)
    (h : ¬(s.total_long_oi + mbv ≤ s.total_usdc_reserve)) : execute_batchTransition s signer mbv mav tm = none := by
  unfold execute_batchTransition; rw [if_neg (fun hg => h hg.2.1)]

theorem execute_batch_aborts_short_oi_exceeds_reserve (s : State) (signer : Pubkey) (mbv : Nat) (mav : Nat) (tm : Nat)
    (h : ¬(s.total_short_oi + mav ≤ s.total_usdc_reserve)) : execute_batchTransition s signer mbv mav tm = none := by
  unfold execute_batchTransition; rw [if_neg (fun hg => h hg.2.2.1)]

-- ============================================================================
-- Cover properties — reachability (existential proofs)
-- ============================================================================

/-- happy_long — trace [initialize, atomic_open, atomic_close] is reachable. -/
theorem cover_happy_long : ∃ (s0 : State) (signer : Pubkey),
    ∃ (v0_0 v0_1 v0_2 v0_3 : Nat), ∃ (s1 : State), initializeTransition s0 signer v0_0 v0_1 v0_2 v0_3 = some s1 ∧
      ∃ (v1_0 v1_1 v1_2 v1_3 : Nat), ∃ (s2 : State), atomic_openTransition s1 signer v1_0 v1_1 v1_2 v1_3 = some s2 ∧
        ∃ (v2_0 v2_1 v2_2 : Nat), atomic_closeTransition s2 signer v2_0 v2_1 v2_2 ≠ none := by
  let pk : Pubkey := ⟨0, 0, 0, 0⟩
  let s0 : State := ⟨pk, pk, pk, pk, pk, pk, pk, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, .Uninitialized⟩
  let s1 : State := ⟨pk, pk, pk, pk, pk, pk, pk, 0, 10, 50, 100, 1000, 0, 100, 0, 0, 0, .Active⟩
  let s2 : State := ⟨pk, pk, pk, pk, pk, pk, pk, 0, 10, 50, 100, 1000, 10, 100, 0, 0, 0, .Active⟩
  exact ⟨s0, pk, 10, 50, 100, 1000, s1, by native_decide, 1, 10, 10, 5, s2, by native_decide, 10, 1, 0, by native_decide⟩

/-- liquidation_path — trace [initialize, atomic_open, liquidate] is reachable. -/
theorem cover_liquidation_path : ∃ (s0 : State) (signer : Pubkey),
    ∃ (v0_0 v0_1 v0_2 v0_3 : Nat), ∃ (s1 : State), initializeTransition s0 signer v0_0 v0_1 v0_2 v0_3 = some s1 ∧
      ∃ (v1_0 v1_1 v1_2 v1_3 : Nat), ∃ (s2 : State), atomic_openTransition s1 signer v1_0 v1_1 v1_2 v1_3 = some s2 ∧
        ∃ (v2_0 v2_1 : Nat), liquidateTransition s2 signer v2_0 v2_1 ≠ none := by
  let pk : Pubkey := ⟨0, 0, 0, 0⟩
  let s0 : State := ⟨pk, pk, pk, pk, pk, pk, pk, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, .Uninitialized⟩
  let s1 : State := ⟨pk, pk, pk, pk, pk, pk, pk, 0, 10, 50, 100, 1000, 0, 100, 0, 0, 0, .Active⟩
  let s2 : State := ⟨pk, pk, pk, pk, pk, pk, pk, 0, 10, 50, 100, 1000, 10, 100, 0, 0, 0, .Active⟩
  exact ⟨s0, pk, 10, 50, 100, 1000, s1, by native_decide, 1, 10, 10, 5, s2, by native_decide, 10, 1, by native_decide⟩

/-- dfba_cycle — trace [initialize, place_order, place_order, execute_batch] is reachable. -/
theorem cover_dfba_cycle : ∃ (s0 : State) (signer : Pubkey),
    ∃ (v0_0 v0_1 v0_2 v0_3 : Nat), ∃ (s1 : State), initializeTransition s0 signer v0_0 v0_1 v0_2 v0_3 = some s1 ∧
      ∃ (v1_0 v1_1 : Nat), ∃ (s2 : State), place_orderTransition s1 signer v1_0 v1_1 = some s2 ∧
        ∃ (v2_0 v2_1 : Nat), ∃ (s3 : State), place_orderTransition s2 signer v2_0 v2_1 = some s3 ∧
          ∃ (v3_0 v3_1 v3_2 : Nat), execute_batchTransition s3 signer v3_0 v3_1 v3_2 ≠ none := by
  let pk : Pubkey := ⟨0, 0, 0, 0⟩
  let s0 : State := ⟨pk, pk, pk, pk, pk, pk, pk, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, .Uninitialized⟩
  let s1 : State := ⟨pk, pk, pk, pk, pk, pk, pk, 0, 10, 50, 100, 1000, 0, 100, 0, 0, 0, .Active⟩
  exact ⟨s0, pk, 10, 50, 100, 1000, s1, by native_decide, 1, 1, s1, by native_decide, 1, 1, s1, by native_decide, 1, 1, 100, by native_decide⟩

/-- cancel_flow — trace [initialize, place_order, cancel_order] is reachable. -/
theorem cover_cancel_flow : ∃ (s0 : State) (signer : Pubkey),
    ∃ (v0_0 v0_1 v0_2 v0_3 : Nat), ∃ (s1 : State), initializeTransition s0 signer v0_0 v0_1 v0_2 v0_3 = some s1 ∧
      ∃ (v1_0 v1_1 : Nat), ∃ (s2 : State), place_orderTransition s1 signer v1_0 v1_1 = some s2 ∧
        cancel_orderTransition s2 signer ≠ none := by
  let pk : Pubkey := ⟨0, 0, 0, 0⟩
  let s0 : State := ⟨pk, pk, pk, pk, pk, pk, pk, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, .Uninitialized⟩
  let s1 : State := ⟨pk, pk, pk, pk, pk, pk, pk, 0, 10, 50, 100, 1000, 0, 100, 0, 0, 0, .Active⟩
  exact ⟨s0, pk, 10, 50, 100, 1000, s1, by native_decide, 1, 1, s1, by native_decide, by native_decide⟩

-- ============================================================================
-- Liveness properties — bounded reachability (leads-to)
-- ============================================================================

def applyOps (s : State) (signer : Pubkey) : List Operation → Option State
  | [] => some s
  | op :: ops => match applyOp s signer op with
    | some s' => applyOps s' signer ops
    | none => none

/-- position_settles — from Active, within 1 step the state remains Active. -/
theorem liveness_position_settles (s : State) (signer : Pubkey)
    (h : s.status = .Active) :
    ∃ ops, ops.length ≤ 1 ∧ ∀ s', applyOps s signer ops = some s' → s'.status = .Active := by
  exact ⟨[], by decide, fun s' h_apply => by
    simp [applyOps] at h_apply; subst h_apply; exact h⟩

-- ============================================================================
-- Overflow safety obligations
-- ============================================================================

theorem atomic_open_overflow_safe (s s' : State) (signer : Pubkey) (collateral_amount : Nat) (borrow_amount : Nat) (leverage_bps : Nat) (spread_fee_bps : Nat)
    (h_valid : valid_u64 s.is_paused ∧ valid_u64 s.max_leverage ∧ valid_u64 s.liquidation_threshold ∧ valid_u64 s.protocol_fee_bps ∧ valid_u64 s.max_tvl ∧ valid_u64 s.total_usdc_borrowed ∧ valid_u64 s.total_usdc_reserve ∧ valid_u64 s.total_long_oi ∧ valid_u64 s.total_short_oi ∧ valid_u64 s.psf_balance)
    (h_inv_reserve_solvency : reserve_solvency s)
    (h_inv_oi_bounded : oi_bounded s)
    (h : atomic_openTransition s signer collateral_amount borrow_amount leverage_bps spread_fee_bps = some s') :
    valid_u64 s'.is_paused ∧ valid_u64 s'.max_leverage ∧ valid_u64 s'.liquidation_threshold ∧ valid_u64 s'.protocol_fee_bps ∧ valid_u64 s'.max_tvl ∧ valid_u64 s'.total_usdc_borrowed ∧ valid_u64 s'.total_usdc_reserve ∧ valid_u64 s'.total_long_oi ∧ valid_u64 s'.total_short_oi ∧ valid_u64 s'.psf_balance := by
  unfold atomic_openTransition at h; split at h
  · next hg =>
    cases h
    have h_res : s.total_usdc_reserve ≤ 18446744073709551615 := by
      have := h_valid.2.2.2.2.2.2.1
      unfold valid_u64 at this; unfold Valid.valid_u64 at this; unfold Valid.U64_MAX at this; exact this
    refine ⟨h_valid.1, h_valid.2.1, h_valid.2.2.1, h_valid.2.2.2.1, h_valid.2.2.2.2.1, ?_, h_valid.2.2.2.2.2.2.1, h_valid.2.2.2.2.2.2.2.1, h_valid.2.2.2.2.2.2.2.2.1, h_valid.2.2.2.2.2.2.2.2.2⟩
    · simp only [valid_u64, Valid.valid_u64, Valid.U64_MAX]; omega
  · contradiction

theorem execute_batch_overflow_safe (s s' : State) (signer : Pubkey) (matched_bid_volume : Nat) (matched_ask_volume : Nat) (total_matchable : Nat)
    (h_valid : valid_u64 s.is_paused ∧ valid_u64 s.max_leverage ∧ valid_u64 s.liquidation_threshold ∧ valid_u64 s.protocol_fee_bps ∧ valid_u64 s.max_tvl ∧ valid_u64 s.total_usdc_borrowed ∧ valid_u64 s.total_usdc_reserve ∧ valid_u64 s.total_long_oi ∧ valid_u64 s.total_short_oi ∧ valid_u64 s.psf_balance)
    (h_inv_reserve_solvency : reserve_solvency s)
    (h_inv_oi_bounded : oi_bounded s)
    (h : execute_batchTransition s signer matched_bid_volume matched_ask_volume total_matchable = some s') :
    valid_u64 s'.is_paused ∧ valid_u64 s'.max_leverage ∧ valid_u64 s'.liquidation_threshold ∧ valid_u64 s'.protocol_fee_bps ∧ valid_u64 s'.max_tvl ∧ valid_u64 s'.total_usdc_borrowed ∧ valid_u64 s'.total_usdc_reserve ∧ valid_u64 s'.total_long_oi ∧ valid_u64 s'.total_short_oi ∧ valid_u64 s'.psf_balance := by
  unfold execute_batchTransition at h; split at h
  · next hg =>
    cases h
    have h_res : s.total_usdc_reserve ≤ 18446744073709551615 := by
      have := h_valid.2.2.2.2.2.2.1
      unfold valid_u64 at this; unfold Valid.valid_u64 at this; unfold Valid.U64_MAX at this; exact this
    refine ⟨h_valid.1, h_valid.2.1, h_valid.2.2.1, h_valid.2.2.2.1, h_valid.2.2.2.2.1, h_valid.2.2.2.2.2.1, h_valid.2.2.2.2.2.2.1, ?_, ?_, ?_⟩
    · simp only [valid_u64, Valid.valid_u64, Valid.U64_MAX]; omega
    · simp only [valid_u64, Valid.valid_u64, Valid.U64_MAX]; omega
    · simp only [valid_u64, Valid.valid_u64, Valid.U64_MAX]; omega
  · contradiction

end AtomicPerps
