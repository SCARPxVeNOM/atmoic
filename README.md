# Composable Perps Hub

Atomic cross-protocol execution layer for perpetual futures on Solana. Borrow, open leveraged positions, and hedge — all in a single atomic transaction.

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
```

**Program (Rust):** 4 instructions — `initialize`, `atomic_open`, `atomic_close`, `liquidate`. Built with raw `solana-program` (no Anchor) for minimal binary size. Pyth oracle validation with <5s staleness and <1% confidence checks.

**Backend (TypeScript):** REST API for transaction building, WebSocket for position updates, liquidator service for health monitoring, oracle relay for Pyth price updates.

**Frontend (React):** Phantom wallet integration, one-click position management, real-time health factor display, Kamino yield APY tracking.

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
- **Program:** Rust, solana-program v1.18.26 (no Anchor dependency)
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
| **Phase 0** (current) | Atomic MVP: Kamino borrow + perp, SOL only | $500K |
| Phase 1 | Oracle vault + dynamic spread + audit | $5M |
| Phase 2 | DFBA batch auction + ALTs + sharded queues | $25M |
| Phase 3 | JLP/mSOL collateral + circuit breakers | Uncapped |
| Phase 4 | Raydium LP + governance token | — |

## Local Development

### Prerequisites
- Rust + Solana CLI (v1.18.26)
- Node.js 18+
- Solana test validator

### Build Program
```bash
cargo build-sbf --features mock-oracle
```

### Run Tests
```bash
solana-test-validator --reset --ledger test-ledger --quiet &
solana program deploy target/deploy/atomic_perps.so --program-id target/deploy/atomic_perps-keypair.json
npm test
```

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
