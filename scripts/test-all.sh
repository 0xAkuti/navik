#!/usr/bin/env bash
# Full test run on a fresh local mainnet fork (real ENSv2 state):
#   contracts (unit + fork tests) → typecheck → fork with Navik deployed → CLI flow →
#   dashboard in headless Chromium → dashboard published to navik.eth → dashboard e2e against
#   the exact bytes navik.eth serves → freeze navik.eth (in a snapshot, reverted afterwards).
# Leaves the fork running on :8545 for manual testing; stop it with `kill $(cat .anvil.pid)`.
# Needs: Foundry, Node >= 22.18, pnpm, and `pnpm install` + `pnpm -C app exec playwright install chromium`.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
export RPC_URL=http://127.0.0.1:8545
OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil #0, owns navik.eth on the fork
WORK=$(mktemp -d)
START=$(date +%s)
step() { printf '\n\033[1;34m### %s\033[0m\n' "$*"; }

if [[ -f .anvil.pid ]]; then
  kill "$(cat .anvil.pid)" 2>/dev/null || true
  rm -f .anvil.pid
  sleep 1
fi
if cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  echo "something else is listening on $RPC_URL; stop it first" >&2
  exit 1
fi
rm -f contracts/deployments/31337*.json

step "contracts: unit and mainnet fork tests"
(cd contracts && forge test)

step "typecheck sdk, cli and app"
pnpm -r run typecheck

step "fresh anvil fork: navik.eth registered, Navik deployed and attached"
./scripts/dev-fork.sh >/dev/null
node cli/src/cli.ts info

step "CLI end-to-end"
bash cli/test/e2e.sh

step "dashboard: gzip loader and full UI flow in headless Chromium"
(cd app && pnpm run e2e)

step "publish the dashboard to app.navik.eth (compressed) so navik.eth serves it"
PRIVATE_KEY=$OWNER_KEY ./scripts/deploy-app.sh

step "dashboard e2e against the exact bytes navik.eth serves"
node cli/src/cli.ts verify navik.eth --raw --out "$WORK/navik.html"
(cd app && APP_FILE="$WORK/navik.html" node test/e2e.ts)

step "freeze navik.eth (inside a snapshot): nobody can repoint it, everything keeps working"
SNAPSHOT=$(cast rpc evm_snapshot --rpc-url "$RPC_URL" | tr -d '"')
(cd contracts && CONFIRM_FREEZE=navik.eth forge script script/Freeze.s.sol \
  --rpc-url "$RPC_URL" --private-key "$OWNER_KEY" --broadcast -q)
node cli/src/cli.ts info | grep -q "frozen: nobody can repoint" && echo "  navik.eth frozen"
if (cd contracts && forge script script/Attach.s.sol --rpc-url "$RPC_URL" --private-key "$OWNER_KEY" --broadcast -q) >/dev/null 2>&1; then
  echo "repointing a frozen navik.eth should fail" >&2
  exit 1
fi
echo "  repointing after the freeze is rejected"
node cli/src/cli.ts verify navik.eth
cast rpc evm_revert "$SNAPSHOT" --rpc-url "$RPC_URL" >/dev/null
echo "  snapshot reverted: the fork is back in its testing phase"

printf '\n\033[1;32mall tests passed in %ss\033[0m; fork still running on %s (dashboard: node cli/src/cli.ts open navik.eth)\n' \
  "$(($(date +%s) - START))" "$RPC_URL"
