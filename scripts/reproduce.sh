#!/usr/bin/env bash
# Rebuilds a site from its source repo and checks the result is byte-identical to what an ENS
# name serves onchain: proof that the shipped frontend matches the public code.
# Works for any ERC-8244 site with a reproducible build, not only Navik's dashboard.
#
#   scripts/reproduce.sh <name> <repo> <ref> <build command> <built file>
#
#   # the dashboard navik.eth serves (mainnet):
#   scripts/reproduce.sh navik.eth https://github.com/<org>/navik <commit> \
#     "pnpm install --frozen-lockfile && NAVIK_CHAINS=1 pnpm -C app build" app/dist/index.html
#
# Reads go to RPC_URL (default http://127.0.0.1:8545).
set -euo pipefail

if [[ $# -ne 5 ]]; then
  sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
fi
NAME=$1 REPO=$2 REF=$3 BUILD=$4 OUT=$5
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git clone --quiet "$REPO" "$WORK/src"
git -C "$WORK/src" -c advice.detachedHead=false checkout --quiet "$REF"
echo "building $(git -C "$WORK/src" rev-parse --short HEAD) of $REPO"
(cd "$WORK/src" && bash -c "$BUILD")
node "$ROOT_DIR/cli/src/cli.ts" verify "$NAME" --against "$WORK/src/$OUT"
