/-
Proofs.lean — user-owned preservation proofs.

`qedgen codegen` bootstraps this file once and never touches it again.
Spec.lean is regenerated; this file is durable. `qedgen check`
(and `qedgen reconcile`) flag orphan theorems (handler removed from
spec) and missing obligations (new `preserved_by` declared).
-/
import Spec

namespace AtomicPerps

open QEDGen.Solana

-- Preservation obligations the spec expects.
-- Write each theorem against the signature generated in Spec.lean
-- (the handler's transition + the property predicate). Close with
-- tactics like `unfold`, `omega`, or `simp_all` as appropriate, or
-- `QEDGen.Solana.IndexedState.forall_update_pres` for per-account
-- invariants in Map-backed specs.
--
--   theorem fee_bounded_preserved_by_initialize
--   theorem fee_bounded_preserved_by_update_config
--   theorem leverage_bounded_preserved_by_initialize
--   theorem leverage_bounded_preserved_by_update_config
--   theorem liquidation_threshold_valid_preserved_by_initialize
--   theorem liquidation_threshold_valid_preserved_by_update_config
--   theorem oi_bounded_preserved_by_atomic_close
--   theorem oi_bounded_preserved_by_atomic_open
--   theorem oi_bounded_preserved_by_execute_batch
--   theorem oi_bounded_preserved_by_initialize
--   theorem oi_bounded_preserved_by_liquidate
--   theorem reserve_solvency_preserved_by_atomic_close
--   theorem reserve_solvency_preserved_by_atomic_open
--   theorem reserve_solvency_preserved_by_cancel_order
--   theorem reserve_solvency_preserved_by_execute_batch
--   theorem reserve_solvency_preserved_by_initialize
--   theorem reserve_solvency_preserved_by_liquidate
--   theorem reserve_solvency_preserved_by_place_order

end AtomicPerps
