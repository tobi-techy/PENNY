#!/usr/bin/env bash
# Build the two wasm artifacts Penny deploys from this workspace.
#
#   res/penny_guard.wasm  one shared Guard contract (contracts/guard)
#   res/test_usd.wasm     tUSD NEP-141 mock for testnet (mock-ft)
#
# Run from anywhere; the script cd's to its own directory. CI runs the same
# commands (.github/workflows/ci.yml, job "contract").
set -euo pipefail
cd "$(dirname "$0")"

TARGET=wasm32-unknown-unknown
OUT=target/$TARGET/release

cargo build --locked --target "$TARGET" --release -p penny-guard -p mock-ft
cp "$OUT/penny_guard.wasm" res/penny_guard.wasm
cp "$OUT/mock_ft.wasm" res/test_usd.wasm

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum res/penny_guard.wasm res/test_usd.wasm
else
  shasum -a 256 res/penny_guard.wasm res/test_usd.wasm
fi
