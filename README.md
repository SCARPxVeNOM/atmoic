<p align="center">
  <img src="https://img.shields.io/badge/Solana-Mainnet-9945FF?style=flat-square&logo=solana" alt="Solana Mainnet" />
  </p>

# IDLExchange

**Formally verified perpetual futures on Solana with four novel DeFi primitives.**

A perps protocol that introduces *self-repaying perpetuals*, *power perpetuals* (squeeth), *portfolio margining*, and *gradual deleveraging* — backed by 18 machine-checked Lean 4 proofs, academic pricing models, and MEV-resistant batch auctions. 132 KB binary, no Anchor runtime.

> **Program ID:** [`8s677udBiKHkCNYzGEroenfN23k1vQjqR3JQvHjZcDWg`](https://solscan.io/account/8s677udBiKHkCNYzGEroenfN23k1vQjqR3JQvHjZcDWg)

---

## Demo

<div align="center">

[![OFFPAY Demo](https://img.youtube.com/vi/SIK8AdwMVOg/maxresdefault.jpg)](https://youtu.be/SIK8AdwMVOg)

**Click the image above to watch the demo on YouTube**

</div>

---

## The Problem

Perpetual futures dominate crypto derivatives — **$85.7 trillion** in volume (2025, CoinGlass). Yet the infrastructure is fundamentally broken:

- **$150 billion** liquidated from traders in 2025 alone (CryptoSlate). Binary liquidation wipes entire positions at the worst possible moment.
- **19.26% annualized funding cost** (Gate.io, 2025) — a silent tax that compounds against every open position.
- **$3.21 billion vanished in 60 seconds** during the October 2025 flash crash, wiping 1.6 million traders (Amberdata).
- **Linear-only payoffs** force traders into constant gamma hedging. No protocol offers convex exposure natively.

Existing Solana perps (Jupiter, Drift) are functional but structurally identical. The problem is not execution — it's the contract design itself. These four primitives address the structural failures.

---

## Four Novel Primitives

### 1. Self-Repaying Perpetuals

**Collateral yield offsets funding costs.** Positions collateralized with JLP (~17-20% APY) or mSOL (~6% APY) use the yield to pay funding, often making the position net-positive.

```
Traditional Perp                    IDLExchange
┌─────────────────┐                ┌─────────────────┐
│ Collateral: SOL  │                │ Collateral: JLP  │
│ Funding: -0.012% │                │ Funding: -0.012% │
│ Yield:    0.000% │                │ Yield:   +0.018% │
│ ─────────────── │                │ ─────────────── │
│ Net:     -0.012% │                │ Net:     +0.006% │
│    (you pay)     │                │    (you earn)    │
└─────────────────┘                └─────────────────┘
```

**How it works:** The funding crank (`settle_funding` instruction) computes per-position effective rates. For yield-bearing collateral, the backend's `funding-crank` service subtracts the 8h yield accrual from the raw funding rate before settlement. On-chain, collateral is directly adjusted — no separate debt token.

**Supported collateral:**
| Asset | Haircut | Yield Source | Typical 8h Yield |
|-------|---------|--------------|------------------|
| SOL | 0% | None | 0 bps |
| JLP | 25% | Jupiter LP fees | ~5.5 bps |
| mSOL | 18% | Staking rewards | ~0.19 bps |

### 2. Power Perpetuals

**Contracts indexed to price^p, delivering options-like convexity without expiry or strike management.** Based on [Paradigm Research, "Power Perpetuals" (2024)](https://www.paradigm.xyz/2021/08/power-perpetuals).



**Example:** If SOL moves +10%, a standard perp gains +10%. A power perp (p=2) gains **+21%** — because PnL = (exit² - entry²) / entry².

**On-chain implementation:** The `Position` struct stores `power_milli` (u64):
- `1000` → standard perp (p=1.0), linear PnL
- `2000` → squeeth (p=2.0), quadratic PnL via `calculate_pnl_power()`
- `500` → sqrt perp (p=0.5), dampened exposure (stretch)

Squeeth positions pay **2x spread** as a convexity premium. Max leverage capped at 5x (vs 10x standard) for risk containment.

### 3. Portfolio Margining

**Risk-based margin across correlated positions.** Instead of liquidating each position independently, the protocol stress-tests the entire portfolio.

```
Individual Margin (status quo)        Portfolio Margin (IDLExchange)
┌───────────────────────────┐        ┌───────────────────────────┐
│ Long  SOL:  $100 margin   │        │                           │
│ Short BTC:  $100 margin   │        │ Worst-case scenario:      │
│ ───────────────────────── │        │   SOL -15%, BTC +5%       │
│ Total:      $200 required │        │ Portfolio loss: $142.50   │
│                           │        │ ───────────────────────── │
│ No hedging benefit.       │        │ Savings: $57.50 (28.8%)   │
└───────────────────────────┘        └───────────────────────────┘
```

**Scenario engine** runs 15 correlated stress tests (combinations of -15% to +15% moves across SOL/BTC/ETH). Portfolio margin = max drawdown across all scenarios.

**Correlation matrix** (empirical, hardcoded):
|     | SOL  | BTC  | ETH  |
|-----|------|------|------|
| SOL | 1.00 | 0.75 | 0.70 |
| BTC | 0.75 | 1.00 | 0.85 |
| ETH | 0.70 | 0.85 | 1.00 |

### 4. Gradual Deleveraging

**Severity-based partial liquidation replaces binary all-or-nothing wipeouts.** The protocol closes proportional slices based on how deep the position is underwater.

```
Margin Ratio        Action               What Happens
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  > 5.0%            Safe                 No action
  4.0% – 5.0%      Zone 1: Close 25%    Partial deleverage
  3.0% – 4.0%      Zone 2: Close 50%    Partial deleverage
  2.0% – 3.0%      Zone 3: Close 75%    Partial deleverage
  < 2.0%            Full Liquidation     Position closed
```

**Why it matters:** During the Oct 2025 crash, 1.6M traders were fully liquidated in a cascade. Gradual deleveraging gives traders a recovery window — a 25% trim at 4.5% margin is survivable; a 100% wipeout at 4.9% is not.

---

## How the Primitives Compose

These are not independent features — they form an interlocking system:

```
                    ┌─────────────────────┐
                    │   Self-Repaying     │
                    │   (yield offsets    │
                    │    funding costs)   │
                    └──────────┬──────────┘
                               │
              Yield-bearing collateral
              keeps margin healthier
                               │
                    ┌──────────▼──────────┐
                    │   Gradual           │
                    │   Deleveraging      │◄──── Fewer full liquidations
                    │   (partial close    │      = smaller cascade risk
                    │  by severity zone)  │
                    └──────────┬──────────┘
                               │
              Surviving positions contribute
              to portfolio-level hedging
                               │
                    ┌──────────▼──────────┐
                    │    Portfolio        │
                    │     Margining       │◄──── Correlated positions
                    │   (cross-position   │      offset each other
                    │   stress testing)   │
                    └──────────┬──────────┘
                               │
              Freed margin capital enables
              more expressive positions
                               │
                    ┌──────────▼──────────┐
                    │   Power Perpetuals  │
                    │   (convex payoffs   │
                    │    without options) │
                    └─────────────────────┘
```

**Self-repaying** keeps positions alive longer → **gradual deleveraging** handles the ones that do decline gracefully → **portfolio margining** nets correlated risk across surviving positions → freed capital enables **power perps** with their higher margin requirements. Each primitive makes the others more effective.

---

## Academic Foundations

The protocol's pricing and risk engines are not heuristic — they implement published models from quantitative finance:

| Model | Application | Formula | Reference |
|-------|-------------|---------|-----------|
| **Avellaneda-Stoikov** | Dynamic spread | r = s - q*γ*σ²*(T-t), δ = γ*σ²*(T-t) + (2/γ)*ln(1+γ/k) | Avellaneda & Stoikov (2008), *Operations Research* |
| **VPIN** | Toxicity scoring | VPIN = \|V_buy - V_sell\| / V_total | Easley, Lopez de Prado & O'Hara (2012) |
| **CUSUM** | Regime detection | Sequential change-point detection for volatility shifts | Page (1954) |
| **RL Funding** | Predictive rates | 24h basis variance minimization, not just current basis zeroing | Cartea, Jaimungal & Walton (2023) |
| **DFBA** | MEV resistance | Uniform clearing price over 15s batches, 8 sharded queues | Budish, Cramton & Shim (2015) |
| **Power Perps** | Convex payoffs | PnL = (exit^p - entry^p) / entry^p * size | Paradigm Research (2024) |

**How academic models map to the four primitives:**

- **Self-Repaying** uses the RL funding model — the predictor doesn't just zero current basis, it minimizes 24h basis variance. This creates smoother funding rates that interact cleanly with yield offsets.
- **Power Perps** are priced through the Avellaneda-Stoikov engine with doubled spread for squeeth (convexity premium), and VPIN toxicity scoring adjusts the premium in real-time.
- **Portfolio Margining** runs stress scenarios using empirical correlations — the scenario engine is a discretized version of Value-at-Risk (VaR) stress testing.
- **Gradual Deleveraging** replaces the binary threshold with a severity curve. The liquidator uses the same Avellaneda-Stoikov reservation price to determine optimal partial-close sizing.

---

## Formal Verification

Three independent verification layers catch different bug classes. The `.qedspec` is the single source of truth — all harnesses and theorems are generated from it.

### Lean 4 Proofs — 18/18 Theorems, Zero `sorry`

Every safety property is mathematically proven to hold across every state transition:

| Property | Theorems | What It Proves |
|----------|----------|----------------|
| `collateral_conservation` | 6 | Collateral is always non-negative across all handlers |
| `oi_tracking` | 3 | Open interest fields never go negative |
| `oi_cap` | 1 | Total OI never exceeds max TVL (80% cap) |
| `leverage_bounds` | 1 | Position notional bounded by max_leverage * deposit |
| `funding_bounds` | 1 | Funding rate stays within +-0.5% per 8h |
| `no_overflow` | 6 | All arithmetic is checked — wrapping is impossible |

**Bug found by formal verification:** The original `leverage_bounds` property was proven **FALSE** — protocol fees reduce collateral below the original deposit while notional is computed from the full deposit. The corrected property tracks the pre-fee deposit amount. This is the exact class of bug that audits miss and formal methods catch.

### Proptest — 28 Harnesses

Random property-based testing at ~1000 cases per harness:
- 18 preservation tests (each property x each handler)
- 5 guard rejection tests (invalid inputs always rejected)
- 3 overflow detection tests (wrapping arithmetic caught)
- 1 state machine sequence test (random operation chains)
- 1 operation dispatcher

### Kani BMC — 8 Harnesses

Bounded model checking via CBMC exhaustively verifies all inputs within bounds:
- 4 invariant preservation proofs
- 2 guard enforcement proofs
- 2 cover properties (reachability)

---

## Risk Parameters

| Parameter | Value | Constant |
|-----------|-------|----------|
| Max Leverage | 10x (5x for power perps) | `DEFAULT_MAX_LEVERAGE` |
| Maintenance Margin | 5% | `MAINTENANCE_MARGIN_BPS = 500` |
| Protocol Fee | 0.1% | `DEFAULT_PROTOCOL_FEE_BPS = 10` |
| Max Funding Rate | +-0.5% per 8h | `MAX_FUNDING_RATE_BPS = 50` |
| Liquidation Bonus | 5% | `LIQUIDATION_BONUS_BPS = 500` |
| DFBA Price Cap | Pyth +-0.3% | `PYTH_CAP_BPS = 30` |
| Oracle Staleness | 60s max | `MAX_ORACLE_AGE_SECONDS` |
| Oracle Confidence | 1% max | `MAX_ORACLE_CONFIDENCE_BPS = 100` |
| Oracle Divergence | 2% (Pyth vs Switchboard) | `ORACLE_DIVERGENCE_BPS = 200` |
| PSF Fee Share | 10% of protocol fees | `PSF_FEE_SHARE_BPS = 1000` |
| OI Cap | 80% of max TVL | `OI_CAP_PCT = 80` |
| Min Spread | 5 bps | `MIN_SPREAD_BPS = 5` |

---

## Non-Reproducible Components

Certain protocol behaviors cannot be replicated from source code alone. They depend on live oracle state, historical data, or off-chain observation windows:

### Avellaneda-Stoikov Spread Calibration

The spread engine requires a **120-observation price ring buffer** (fed every ~15s by the circuit breaker) to compute σ² (price variance in USD²/second). A fresh deployment starts with zero observations — the engine falls back to `MIN_SPREAD_BPS` (5 bps) until the buffer fills (~30 minutes).

The risk aversion parameter γ is calibrated so γ*s ≈ 0.01 at the current mid price. This is not a static constant — it adjusts dynamically. There is no config file; the calibration is emergent from the live price feed.

### RL-Enhanced Funding Rate

The funding predictor maintains a **24-hour basis observation history** with skew, OI imbalance, and basis measurements. It minimizes predicted basis *variance* over the next 24h, not just the current basis. This means:

- A fresh deployment produces the raw (mark - index) / index rate
- After 24h of observations, the controller activates and adjusts rates
- The adjustment depends on the specific sequence of basis observations — it is path-dependent

The weights are not static. They evolve based on observed market microstructure. Two deployments with different initial trading patterns will produce different funding rate behaviors.

### VPIN Toxicity Scoring

VPIN (Volume-Synchronized Probability of Informed Trading) maintains a rolling window of 50 batch results. The spread multiplier depends on this history:
- VPIN > 0.7 → 1.5x spread (toxic flow detected)
- VPIN < 0.3 → 0.8x spread (noise flow, tighten)
- Between → 1.0x

This history is in-memory and non-persistent. A service restart resets VPIN to the neutral 0.5 default.

### JLP Yield Computation

Self-repaying funding offsets depend on the **live JLP price trajectory** relative to each position's entry price. The 8h yield is computed as:

```
yield_8h = ((current_jlp_price - entry_jlp_price) / entry_jlp_price) * (8h / elapsed)
```

This is position-specific and time-specific. Two identical positions opened at different JLP prices will have different effective funding rates. The yield data comes from Jupiter's live price feed — it cannot be mocked or replicated from static data.

### Portfolio Margin Scenario Engine

The 15 stress scenarios use a **static correlation matrix** (reproducible), but the portfolio margin result depends on the **specific set of open positions** at query time. Two wallets with different position compositions will produce different savings percentages. The worst-case scenario label (e.g., "SOL -15%, BTC +5%") changes based on which positions are open.

### Commit-Reveal Order Flow

Large DFBA orders (>$10K notional) use commit-reveal to prevent frontrunning. The commitment hash is `SHA256(user || price || size || nonce)`. The nonce is generated client-side and never stored on-chain — only the hash is. If a user loses their nonce before reveal, the order is unrecoverable. This is by design.

---

## Tech Stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Blockchain | Solana Mainnet | ~400ms slot time |
| On-Chain Program | Rust, `solana-program` v1.18.26 | No Anchor runtime, 132 KB binary |
| Formal Verification | Lean 4 (v4.30.0-rc2), QEDGen | 18 theorems, 0 sorry |
| Property Testing | proptest, Kani (CBMC) | 28 + 8 harnesses |
| Backend | TypeScript, Express, pino | 8 concurrent services |
| Frontend | React 18, Vite, TradingView | Phantom + Privy wallets |
| Oracle | Pyth Network (pull, Hermes) | Switchboard fallback |
| Build | `cargo build-sbf`, opt-level "z", LTO fat, strip | Minimal binary |

---

## Deployment

| Detail | Value |
|--------|-------|
| Program ID | `8s677udBiKHkCNYzGEroenfN23k1vQjqR3JQvHjZcDWg` |
| Network | Solana Mainnet |
| Binary Size | 132 KB |
| Build Profile | `opt-level = "z"`, `lto = "fat"`, `strip = true`, `panic = "abort"` |
| Upgrade Authority | Deploy keypair |

**Oracle Feeds (Mainnet):**
| Market | Pyth Account |
|--------|-------------|
| SOL/USD | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` |
| BTC/USD | `4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo` |
| ETH/USD | `42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC` |

---

## Project Structure

```
atomic/
├── programs/atomic_perps/
│   ├── src/
│   │   ├── lib.rs                 # Entrypoint, discriminator routing
│   │   ├── state.rs               # GlobalConfig (492B), Position (187B), Order, Queue
│   │   ├── constants.rs           # All protocol parameters
│   │   ├── errors.rs              # Error codes
│   │   ├── events.rs              # CPI event emission
│   │   ├── utils/
│   │   │   └── math.rs            # PnL, health, haircuts, spread, power PnL
│   │   └── instructions/
│   │       ├── initialize.rs      # One-time setup
│   │       ├── atomic_open.rs     # Open position (supports power_milli)
│   │       ├── atomic_close.rs    # Close position (power-aware PnL)
│   │       ├── liquidate.rs       # Gradual deleveraging + power PnL
│   │       ├── settle_funding.rs  # 8h funding settlement
│   │       ├── update_config.rs   # Admin config updates
│   │       ├── migrate_config.rs  # V1→V4 state migration
│   │       ├── place_order.rs     # DFBA order placement
│   │       ├── cancel_order.rs    # DFBA order cancellation
│   │       ├── execute_batch.rs   # DFBA batch clearing
│   │       └── init_queue_shard.rs # DFBA queue initialization
│   ├── formal_verification/
│   │   ├── Spec.lean              # Generated from .qedspec
│   │   ├── Proofs.lean            # 18 hand-written theorems
│   │   └── lean_solana/           # QEDGen support library
│   └── atomic_perps.qedspec       # Formal spec (source of truth)
├── backend/src/
│   ├── index.ts                   # Service orchestrator
│   ├── services/
│   │   ├── api.ts                 # REST + WebSocket API
│   │   ├── liquidator.ts          # Position health scanner
│   │   ├── funding-crank.ts       # 8h funding settlement
│   │   └── dfba-crank.ts          # 15s batch clearing
│   └── lib/
│       ├── health.ts              # Margin ratio + deleverage zones
│       ├── spread.ts              # Avellaneda-Stoikov engine
│       ├── funding.ts             # RL-enhanced funding rates
│       ├── dfba.ts                # Batch clearing + VPIN
│       ├── portfolio-margin.ts    # 15-scenario stress testing
│       ├── ix-builders.ts         # Instruction construction
│       └── decode.ts              # On-chain account deserialization
├── app/src/
│   ├── pages/                     # Trade, Portfolio, DFBA, Intro
│   ├── components/                # TradePanel, PositionsTable, PowerPerpScene, etc.
│   └── hooks/                     # usePosition, useFundingRate, usePortfolioHealth
├── .github/workflows/verify.yml   # CI: Lean + Proptest + Kani
└── Cargo.toml                     # Workspace config
```

---

## License

MIT
