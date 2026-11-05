#!/usr/bin/env bash
# Builds the dashboard for the connected chain and publishes it to the root project
# (app.navik.eth by default), promoting it so navik.eth itself serves it.
# Needs PRIVATE_KEY of the root project owner (or a key granted publish + promote).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
DEPLOYMENT="${NAVIK_DEPLOYMENT:-$ROOT_DIR/contracts/deployments/$CHAIN_ID.json}"
PROJECT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rootProject"])' "$DEPLOYMENT")

(cd "$ROOT_DIR/app" && NAVIK_CHAINS="$CHAIN_ID" pnpm -s exec vite build --logLevel warn)
node "$ROOT_DIR/cli/src/cli.ts" deploy "$PROJECT" "$ROOT_DIR/app/dist/index.html" --promote "$@"
