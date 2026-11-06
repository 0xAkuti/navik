#!/usr/bin/env bash
# Builds the dashboard for the connected chain and publishes it to the root project
# (app.navik.eth by default), promoting it so navik.eth itself serves it.
# Needs the root project owner (or a key granted publish + promote): --account <name> for a
# Foundry keystore account, or PRIVATE_KEY.
#
# NAVIK_PROVENANCE=1 also records on Arkiv which commit and command built it (the tree must be
# clean; the key needs tGLM on Arkiv), and with SWARM_API + SWARM_BATCH puts the source on Swarm,
# so anyone can run `navik reproduce navik.eth --yes`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"
CHAIN_ID=$(cast chain-id --rpc-url "$RPC_URL")
DEPLOYMENT="${NAVIK_DEPLOYMENT:-$ROOT_DIR/contracts/deployments/$CHAIN_ID.json}"
PROJECT=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["rootProject"])' "$DEPLOYMENT")

PROVENANCE=()
if [[ "${NAVIK_PROVENANCE:-}" == 1 ]]; then
  PROVENANCE=(--build "pnpm install --frozen-lockfile && NAVIK_CHAINS=$CHAIN_ID pnpm -C app build")
  [[ -n "${SWARM_BATCH:-}" ]] && PROVENANCE+=(--swarm)
fi

(cd "$ROOT_DIR/app" && NAVIK_CHAINS="$CHAIN_ID" pnpm -s exec vite build --logLevel warn)
node "$ROOT_DIR/cli/src/cli.ts" deploy "$PROJECT" "$ROOT_DIR/app/dist/index.html" --compress --promote "${PROVENANCE[@]}" "$@"
