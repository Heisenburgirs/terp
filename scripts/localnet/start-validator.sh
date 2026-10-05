#!/bin/bash
# LOCAL SIMULATION ONLY. Starts a throwaway solana-test-validator with:
#   - the deployed Meteora DLMM program, cloned from mainnet (read-only);
#   - the Phoenix SOL orderbook account, cloned from mainnet, so a market can be listed;
#   - the locally built terp program;
#   - the MOCK USDC mint written by setup.ts.
# Nothing is sent to mainnet. Run from the repository root, on Linux (WSL).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
LEDGER="${LEDGER:-$HOME/terp-localnet-ledger}"
exec solana-test-validator --reset \
  --ledger "$LEDGER" \
  --url "${MAINNET_RPC_URL:-https://api.mainnet-beta.solana.com}" \
  --clone-upgradeable-program LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo \
  --clone 71Si24E4uc3oCaPbPZTozC1ptSNNqygjjebxSmErSsC2 \
  --clone EVhkquLbfm5rDRXtZu9FoyDSXX5mYq2EYU6yD8zfKEqM \
  --account EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v "$ROOT/.localnet/usdc-mint.json" \
  --bpf-program 8mGW6pAB1H2mpyx8muVQTAEVf9dLLGxu5H3h4Ch2GtAh "$ROOT/target/deploy/terp.so" \
  --rpc-port 8899
