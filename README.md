# Composable Perps Hub

Atomic cross-protocol execution layer for perpetual futures on Solana — with **84 machine-checked safety proofs** in Lean 4. Borrow, open leveraged positions, and hedge — all in a single atomic transaction.

## Problem

Perpetual futures platforms today operate in isolation. Hyperliquid runs on its own app-chain with no composability. Drift and Jupiter Perps live on Solana but don't compose with lending protocols. Traders must manually borrow, bridge, and execute across multiple transactions — each one a point of failure.

## Solution

Composable Perps Hub enables **atomic borrow-to-trade**: a single Solana transaction that borrows USDC via Kamino Klend, opens a leveraged perp position, and optionally hedges via Jupiter — all-or-nothing. If any step fails, the entire transaction reverts.

This is only possible on Solana, where CPI (Cross-Program Invocation) enables atomic composability across protocols in a single transaction.

## How It Works

```
User clicks "Open 2x Long SOL"
         │
         ▼
┌─────────────────────────────────────────────┐
│            Single Solana Transaction         │
│                                              │
│  1. Deposit SOL collateral → sol_vault       │
│  2. Borrow USDC from reserve (fee applied)   │
│  3. Open synthetic perp at Pyth oracle price │
│  4. (Optional) Kamino CPI borrow             │
│  5. Health check — revert if unhealthy       │
│                                              │
│  All-or-nothing: any failure = full revert   │
└─────────────────────────────────────────────┘
```

## Formal Verification

This protocol is verified with **84 Lean 4 theorems, 0 `sorry`, 0 errors**. Every safety property is proven to hold across every state transition the program can execute.

| Category | Count | What it proves |
|----------|-------|----------------|
| Preservation | 40 | Each of 5 safety properties holds after every handler |
| Inductive | 5 | Property holds after *any* operation sequence |
| Abort conditions | 21 | Invalid inputs are always rejected |
| Cover (reachability) | 4 | Key user flows are reachable (not dead code) |
| Transfer conservation | 6 | No tokens created or destroyed in any SPL transfer |
| Overflow safety | 2 | u64 overflow cannot occur in `atomic_open` or `execute_batch` |
| Invariants | 5 | Collateral flow, fee routing, liquidation math, DFBA price bounds |
| Liveness | 1 | Active positions can always settle |

**5 Safety Properties** (preserved by all 8 handlers):
1. `reserve_solvency` — borrowed USDC never exceeds the reserve
2. `leverage_bounded` — max_leverage is always positive
3. `fee_bounded` — protocol fee stays within basis points range
4. `oi_bounded` — total open interest bounded by reserve
5. `liquidation_threshold_valid` — threshold stays within basis points range

**Bug found by formal verification:** Proving `oi_bounded` for `execute_batch` failed with only per-side OI guards. The combined guard (`long_oi + bid_vol + short_oi + ask_vol <= reserve`) was required — added to the program before deployment.

See: [`formal_verification/Spec.lean`](formal_verification/Spec.lean) | [`atomic_perps.qedspec`](atomic_perps.qedspec)

## Architecture

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Frontend   │────▶│   Backend    │────▶│   Solana      │
│   React +    │     │   Express    │     │   Program     │
│   Phantom    │     │   REST + WS  │     │   (on-chain)  │
└──────────────┘     └──────────────┘     └──────────────┘
                           │                     │
                     ┌─────┴─────┐         ┌─────┴─────┐
                     │Liquidator │         │  Kamino    │
                     │  Service  │         │  Klend    │
                     └───────────┘         │  (CPI)    │
                     ┌───────────┐         └───────────┘
                     │  Oracle   │         ┌───────────┐
                     │  Relay    │         │   Pyth    │
                     └───────────┘         │  Oracle   │
                                           └───────────┘
┌──────────────────────────────────────────────────────────┐
│  Formal Verification (offline, pre-deploy)               │
│  .qedspec → QEDGen → Lean 4 Spec.lean → lake build      │
│  84 theorems, 0 sorry — safety for all 8 handlers        │
└──────────────────────────────────────────────────────────┘
```

**Program (Rust):** 10 instructions — core: `initialize`, `atomic_open`, `atomic_close`, `liquidate`, `update_config`, `migrate_config`; DFBA: `execute_batch`, `place_order`, `cancel_order`, `init_queue_shard`. Built with raw `solana-program` (no Anchor runtime) for minimal binary size (132 KB).

**Backend (TypeScript):** REST API for transaction building, WebSocket for position updates, liquidator service for health monitoring, oracle relay for Pyth price updates.

**Frontend (React):** Phantom wallet integration, one-click position management, real-time health factor display, Kamino yield APY tracking.

**Formal Verification (Lean 4):** QEDGen-generated specification + hand-written Lean 4 proofs. 84 theorems, 0 sorry.

## Protocol Integrations

| Protocol | Role | Integration |
|----------|------|-------------|
| **Kamino Klend** | Borrow USDC against collateral | CPI pass-through via klend-sdk |
| **Pyth Network** | SOL/USD price oracle | On-chain PriceUpdateV2 parsing |
| **Jupiter** | Optional spot hedge swaps | CPI pass-through (feature-gated) |

## Risk Parameters (Phase 0)

| Parameter | Value | Source |
|-----------|-------|--------|
| Max Leverage | 10x | limitations-handbook |
| Liquidation Threshold | 85% LTV | limitations-handbook |
| Protocol Fee | 0.1% (10 bps) | limitations-handbook |
| TVL Cap | $500K USDC | limitations-handbook |
| Oracle Staleness | <5 seconds | master-moves M-1 |
| Oracle Confidence | <1% spread | master-moves M-1 |
| Collateral | SOL only | Phase 0 scope |

## Tech Stack

- **Blockchain:** Solana (mainnet)
- **Program:** Rust, solana-program v1.18.26 (no Anchor runtime dependency)
- **Formal Verification:** Lean 4 (v4.30.0-rc1), QEDGen
- **Backend:** TypeScript, Express, @kamino-finance/klend-sdk
- **Frontend:** React 18, @solana/wallet-adapter, Vite
- **Oracle:** Pyth Network (Hermes + on-chain PriceUpdateV2)

## Mainnet Deployment

| Detail | Value |
|--------|-------|
| Program ID | `8s677udBiKHkCNYzGEroenfN23k1vQjqR3JQvHjZcDWg` |
| Network | Solana Mainnet |
| Binary Size | 132 KB |
| Upgrade Authority | Deploy keypair |

## Phase Roadmap

| Phase | Scope | TVL Cap |
|-------|-------|---------|
| **Phase 0** (current) | Atomic MVP + DFBA batch auction + formal verification (84 proofs) | $500K |
| Phase 1 | Oracle vault + dynamic spread + audit | $5M |
| Phase 2 | Commit-reveal orders + ALTs + multi-market | $25M |
| Phase 3 | JLP/mSOL collateral + circuit breakers | Uncapped |
| Phase 4 | Raydium LP + governance token | — |

## Local Development

### Prerequisites
- Rust + Solana CLI (v1.18.26)
- Anchor CLI (v0.30+)
- Node.js 18+
- Lean 4 (v4.30.0-rc1) — for formal verification only

### Build Program
```bash
anchor build --no-idl -- --features mock-oracle,dfba
```

### Run Tests
```bash
anchor test --skip-build
```

### Verify Proofs
```bash
cd formal_verification && lake build
```
All 84 theorems must pass with 0 errors, 0 sorry.

### Start Backend
```bash
cd backend
cp .env.example .env  # fill in values
npm run dev
```

### Start Frontend
```bash
cd app
npm run dev
```

## License

MIT
