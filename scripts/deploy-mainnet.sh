#!/usr/bin/env bash
#
# Mainnet deploy for atomic_perps.
#
# Prerequisites:
#   - `solana config get` points at mainnet-beta with a funded wallet (~0.5 SOL)
#   - `anchor --version` ≥ 0.30.1
#   - program ID in Anchor.toml matches target/deploy/atomic_perps-keypair.json
#
# This script intentionally does NOT run `anchor init`-style commands.
# It only builds, deploys, and prints next steps for the initialize call.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Verifying cluster"
solana config get

echo "==> Checking wallet balance"
BAL=$(solana balance | awk '{print $1}')
echo "Wallet balance: $BAL SOL"
if (( $(echo "$BAL < 1.55" | bc -l) )); then
  echo "ERROR: need at least 1.55 SOL for program deploy + tx fees (binary tight rent ≈ 1.36 SOL)"
  exit 1
fi

echo "==> Building program"
cargo-build-sbf --manifest-path programs/atomic_perps/Cargo.toml

SO_FILE=target/deploy/atomic_perps.so
SO_SIZE=$(stat -c '%s' "$SO_FILE")
echo "==> Binary: $SO_SIZE bytes ($(awk "BEGIN{printf \"%.1f\", $SO_SIZE/1024}") KB)"
TIGHT_SOL=$(awk "BEGIN{printf \"%.3f\", $SO_SIZE*6960/1e9}")
echo "==> Tight deploy rent: $TIGHT_SOL SOL"

echo "==> Deploying to mainnet-beta with --max-len=$SO_SIZE (tight allocation, no upgrade headroom)"
solana program deploy "$SO_FILE" --max-len "$SO_SIZE" --url mainnet-beta

PROGRAM_ID=$(solana address -k target/deploy/atomic_perps-keypair.json)
echo ""
echo "==> Deployed: $PROGRAM_ID"
echo ""
echo "Next steps:"
echo "  1. Set ATOMIC_PERPS_PROGRAM_ID=$PROGRAM_ID in backend/.env and app/.env"
echo "  2. Pre-create SOL vault + USDC reserve token accounts owned by the program_authority PDA:"
echo "       AUTH=\$(solana address --derived $PROGRAM_ID authority)  # not a real command — see scripts/setup-accounts.ts"
echo "  3. Run the initialize tx with mainnet Kamino/Jupiter/Pyth IDs + \$500K TVL cap"
echo "  4. Transfer upgrade authority to Squads multisig"
echo "       solana program set-upgrade-authority $PROGRAM_ID --new-upgrade-authority <MULTISIG_PDA>"
echo "  5. Smoke-test: deposit 0.01 SOL → atomic_open 2x long → close"
