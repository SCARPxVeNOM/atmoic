# Formal Verification — Atomic Perps

Machine-checked safety proofs for the Atomic Perps Solana program, written in Lean 4.

## Results

- **84 theorems**, **0 `sorry`**, **0 errors**
- Lean 4 v4.30.0-rc1
- Generated from [`atomic_perps.qedspec`](../atomic_perps.qedspec) via QEDGen

## How to Build

```bash
lake build
```

Requires Lean 4 v4.30.0-rc1 (see `lean-toolchain`). A successful build means all 84 theorems are machine-checked.

## What is Proven

### Safety Properties (5 properties x 8 handlers = 40 preservation theorems)

| Property | Definition |
|----------|-----------|
| `reserve_solvency` | `total_usdc_borrowed <= total_usdc_reserve` |
| `leverage_bounded` | `max_leverage > 0` |
| `fee_bounded` | `protocol_fee_bps <= 10000` |
| `oi_bounded` | `total_long_oi + total_short_oi <= total_usdc_reserve` |
| `liquidation_threshold_valid` | `liquidation_threshold <= 10000` |

Each property has a `_preserved_by_<handler>` theorem for all 8 handlers, plus an `_inductive` master theorem proving it is an inductive invariant over arbitrary operation sequences.

### Abort Conditions (21 theorems)

Prove that invalid inputs are always rejected:
- `initialize` rejects zero leverage, zero threshold, threshold > 10000, fee > 10000
- `update_config` rejects unauthorized signer
- `atomic_open` rejects paused state, zero collateral, zero borrow, excessive leverage, spread below min, borrow exceeding reserve, borrow exceeding TVL, OI exceeding cap
- `atomic_close` rejects zero borrow, borrow exceeding total borrowed
- `liquidate` rejects zero borrow, borrow exceeding total borrowed
- `place_order` rejects zero price, zero size
- `execute_batch` rejects long OI exceeding reserve, short OI exceeding reserve

### Cover / Reachability (4 theorems)

Existential proofs that key user flows are reachable (not dead code):
- `happy_long`: initialize -> atomic_open -> atomic_close
- `liquidation_path`: initialize -> atomic_open -> liquidate
- `dfba_cycle`: initialize -> place_order -> place_order -> execute_batch
- `cancel_flow`: initialize -> place_order -> cancel_order

### Transfer Conservation (6 theorems)

Prove no tokens are created or destroyed in any SPL token transfer:

`(source - amount) + (dest + amount) = source + dest`

Covers: atomic_open collateral deposit, atomic_close borrow repayment + collateral return + fee payment, liquidate bonus + remainder distribution.

### Overflow Safety (2 theorems)

Prove u64 overflow cannot occur in `atomic_open` or `execute_batch`, given that all state fields start as valid u64 values and safety invariants hold.

### Invariants (5 theorems)

Structural properties: authority identity, collateral flow conservation, fee routing correctness, liquidation incentive math (`bonus + remainder = collateral`), DFBA clearing price bounded within Pyth +/- 0.3%.

### Liveness (1 theorem)

From Active state, positions can always settle via `atomic_close` or `liquidate` (state remains Active within 1 step).

## The Combined OI Guard Discovery

During verification, the `oi_bounded` preservation proof for `execute_batch` failed. The original code only had per-side guards:
- `total_long_oi + matched_bid_volume <= total_usdc_reserve`
- `total_short_oi + matched_ask_volume <= total_usdc_reserve`

Lean's `omega` tactic could not close the goal because these two individual bounds do not imply the combined bound `total_long_oi + matched_bid_volume + total_short_oi + matched_ask_volume <= total_usdc_reserve`. A third combined guard was required and was added to both the `.qedspec` and the Rust program.

This is a concrete example of formal verification finding a real bug that testing alone might miss.

## File Structure

| File | Purpose |
|------|---------|
| `Spec.lean` | All 84 theorems (auto-generated scaffold + hand-written proofs) |
| `Proofs.lean` | Durable user-owned proof stubs |
| `lakefile.lean` | Lake build configuration |
| `lean-toolchain` | Pins Lean 4 v4.30.0-rc1 |
| `lean_solana/` | QEDGen Solana support library (Account, State, Cpi, Valid) |
