import Lake
open Lake DSL

package atomic_perpsProofs

require qedgenSupport from
  "./lean_solana"

@[default_target]
lean_lib Atomic_perpsSpec where
  roots := #[`Spec, `Proofs]
