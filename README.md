# Atomic Perps

Formally verified perpetual futures protocol on Solana — with **18 machine-checked Lean 4 proofs**, property-based testing, and bounded model checking. Pure margin model, academic pricing, MEV-resistant batch auctions.

## Problem

Perpetual futures on Solana lack formal safety guarantees. Existing protocols (Drift, Jupiter Perps) rely on test suites and audits — necessary but insufficient. A single arithmetic edge case in leverage computation or OI tracking can drain a vault. Meanwhile, traders face MEV extraction on every fill.

## Solution

Atomic Perps is a **pure perps protocol** (GMX/Jupiter Perps vault-as-counterparty model) with three differentiators:

1. **Formal Verification** — 18 Lean 4 theorems prove safety properties hold across every state transition, with zero `sorry`. Backed by proptest random testing and Kani bounded model checking.
2. **Academic Mechanism Design** — Avellaneda-Stoikov spread pricing, CUSUM regime detection, VPIN toxicity scoring, and predictive funding rates.
3. **DFBA Batch Auctions** — Discrete Frequent Batch Auctions for MEV-resistant order execution.

## How It Works

```
User clicks "Open 5x Long SOL"
         |
         v
+---------------------------------------------+
|         Single Solana Transaction            |
|                                              |
|  1. Deposit SOL collateral -> vault          |
|  2. Compute notional: deposit * leverage     |
|  3. Deduct fee from collateral               |
|  4. Open synthetic perp at Pyth oracle price |
|  5. Update OI tracking (long/short)          |
|  6. Margin check -- revert if unhealthy      |
|                                              |
|  All-or-nothing: any failure = full revert   |
+---------------------------------------------+
         |
    On close:
    PnL = (exit_price - entry_price) * size
    Collateral +/- PnL returned to trader
    Losers fund winners (vault-as-counterparty)
```

No borrowing. No external liquidity required. The vault is self-funded by trader deposits.

## Formal Verification

This protocol uses the **QEDGen verification waterfall** — three independent layers catching different bug classes:

### Lean 4 Proofs (18/18, zero sorry)

Every safety property is mathematically proven to hold across every state transition.

| Property | Theorems | What it proves |
|----------|----------|----------------|
| `collateral_conservation` | 6 | Total collateral is always non-negative |
| `oi_tracking` | 3 | Open interest fields are always non-negative |
| `oi_cap` | 1 | Total OI never exceeds max TVL |
| `leverage_bounds` | 1 | Position notional bounded by max_leverage * deposit |
| `funding_bounds` | 1 | Funding rate stays within 1% cap |
| `no_overflow` | 6 | Collateral + size arithmetic cannot wrap |

**Bug found by formal verification:** The original `leverage_bounds` property (`size_usd <= collateral * max_leverage / 1000`) was proven FALSE — fees reduce collateral below deposit while notional is computed from the full deposit. The corrected property tracks the pre-fee deposit amount. This is exactly the kind of bug formal methods are designed to catch.

### Proptest (28 harnesses)

Random property-based testing finds counterexamples in milliseconds:
- 18 preservation tests (each property x each handler)
- 5 guard rejection tests (invalid inputs always rejected)
- 3 overflow detection tests (wrapping arithmetic caught)
- 1 state machine sequence test (random operation chains)
- 1 operation dispatcher

### Kani BMC (8 harnesses)

Bounded model checking via CBMC exhaustively verifies all possible inputs:
- 4 invariant preservation proofs (oi_cap, leverage_bounds, funding_bounds, no_overflow)
- 2 guard enforcement proofs (reject zero deposit, reject excessive funding rate)
- 2 cover properties (open->close and open->liquidate paths are reachable)

### CI Pipeline

`.github/workflows/verify.yml` runs all three layers on every push:
- `lake build` — Lean 4 proofs compile with zero sorry
- `cargo test --test proptest` — property tests pass
- `cargo kani` — bounded model checking passes

## Architecture

```
+---------------+     +---------------+     +---------------+
|   Frontend    |---->|   Backend     |---->|   Solana       |
|   React 18    |     |   Express     |     |   Program      |
|   Phantom     |     |   REST + WS   |     |   (on-chain)   |
+---------------+     +---------------+     +---------------+
                            |                     |
                      +-----+-----+         +-----+-----+
                      |Liquidator |         |   Pyth    |
                      |  Service  |         |  Oracle   |
                      +-----------+         +-----------+
                      +-----------+
                      | Funding   |
                      |  Crank    |
                      +-----------+

+----------------------------------------------------------+
| Formal Verification (offline, pre-deploy)                |
| .qedspec -> QEDGen -> Lean 4 + Proptest + Kani + CI     |
| 18 theorems (0 sorry) + 28 proptest + 8 kani harnesses  |
+----------------------------------------------------------+
```

**Program (Rust):** 6 core instructions — `initialize`, `atomic_open`, `atomic_close`, `liquidate`, `settle_funding`, `update_config`. Built with raw `solana-program` (no Anchor runtime) for minimal binary size (132 KB).

**Backend (TypeScript):** REST API for transaction building, WebSocket for position updates, liquidator service with margin-ratio health checks, funding rate crank (8h settlement cycle), Avellaneda-Stoikov spread engine, CUSUM regime detector, VPIN toxicity scorer.

**Frontend (React):** Phantom wallet integration, one-click position management, real-time PnL display, leverage selector, partial close support.

**Formal Verification (Lean 4 + QEDGen):** `.qedspec` is the single source of truth. QEDGen generates Lean 4 specs, proptest harnesses, Kani harnesses, and CI workflows. 18 theorems proved by hand in Lean 4, zero sorry.

## Academic Foundations

| Model | Purpose | Reference |
|-------|---------|-----------|
| **Avellaneda-Stoikov** | Dynamic spread pricing based on inventory risk | Avellaneda & Stoikov (2008) |
| **CUSUM** | Regime change detection for volatility shifts | Page (1954) |
| **VPIN** | Volume-synchronized probability of informed trading | Easley, Lopez de Prado & O'Hara (2012) |
| **Predictive Funding** | Forward-looking funding rates from orderflow signals | Novel combination |
| **DFBA** | Discrete Frequent Batch Auctions for MEV resistance | Budish, Cramton & Shim (2015) |

## Risk Parameters

| Parameter | Value |
|-----------|-------|
| Max Leverage | 10x (10000 bps) |
| Maintenance Margin | 5% (500 bps) |
| Protocol Fee | 1% (100 bps) |
| Max Funding Rate | 1% per 8h (100 bps) |
| Liquidation Bonus | 5% (500 bps) |
| Collateral | SOL (Phase 0) |
| Oracle | Pyth Network |

## Tech Stack

- **Blockchain:** Solana Mainnet
- **Program:** Rust, solana-program v1.18.26 (no Anchor)
- **Formal Verification:** Lean 4 (v4.30.0-rc2), QEDGen v2.10.0
- **Property Testing:** proptest, Kani (CBMC)
- **Backend:** TypeScript, Express
- **Frontend:** React 18, @solana/wallet-adapter, Vite
- **Oracle:** Pyth Network (Hermes + on-chain PriceUpdateV2)

## Mainnet Deployment

| Detail | Value |
|--------|-------|
| Program ID | `8s677udBiKHkCNYzGEroenfN23k1vQjqR3JQvHjZcDWg` |
| Network | Solana Mainnet |
| Binary Size | 132 KB |
| Upgrade Authority | Deploy keypair |

## Local Development

### Prerequisites
- Rust + Solana CLI (v1.18.26)
- Node.js 18+
- Lean 4 (v4.30.0-rc2) — for formal verification
- Kani (optional) — for bounded model checking

### Verify Proofs
```bash
cd programs/atomic_perps/formal_verification && lake build
# All 18 theorems must pass with 0 errors, 0 sorry
```

### Run Property Tests
```bash
cd programs/atomic_perps/programs
cargo test --test proptest
```

### Run Kani (Linux/WSL only)
```bash
cargo kani --tests
```

### Start Backend
```bash
cd backend
cp .env.example .env
npm run dev
```

### Start Frontend
```bash
cd app
npm run dev
```

## License

MIT
