#!/usr/bin/env bash
# End-to-end CLI flow against a local mainnet fork with real ENSv2 (see scripts/dev-fork.sh).
set -euo pipefail

CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="$(cd "$CLI_DIR/.." && pwd)"
export RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"

if ! cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1; then
  "$ROOT_DIR/scripts/dev-fork.sh" >/dev/null
fi

MNEMONIC="test test test test test test test test test test test junk"
key() { cast wallet private-key --mnemonic "$MNEMONIC" --mnemonic-index "$1"; }
address() { cast wallet address --private-key "$1"; }
TEAM=$(key 0)    # owns navik.eth
ALICE=$(key 1)   # project creator
CI=$(key 2)      # alice's deploy key
MALLORY=$(key 3)
CI_ADDR=$(address "$CI")

PROJECT="e2e$(date +%s)"
WORK=$(mktemp -d)
printf '<!doctype html><title>%s</title><h1>hello v1</h1>' "$PROJECT" > "$WORK/v1.html"
printf '<!doctype html><title>%s</title><h1>hello v2</h1>' "$PROJECT" > "$WORK/v2.html"

navik() { node "$CLI_DIR/src/cli.ts" "$@"; }
as() { local k=$1; shift; PRIVATE_KEY=$k navik "$@"; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fails() {
  if "$@" >"$WORK/out" 2>&1; then
    cat "$WORK/out"; echo "expected failure: $*" >&2; exit 1
  fi
  echo "  (rejected as expected) $(tail -1 "$WORK/out")"
}
live_is() {
  local got
  got=$(navik resolve "$PROJECT")
  [[ "$got" == *"$1"* ]] || { echo "expected production $1, got: $got" >&2; exit 1; }
  echo "  $got"
}

step "claim $PROJECT.navik.eth as alice"
as "$ALICE" claim "$PROJECT"

step "deploy v1 and promote"
as "$ALICE" deploy "$PROJECT" "$WORK/v1.html" --promote
V1=$(navik resolve "$PROJECT-v1" | awk '{print $3}')
live_is "$V1"

step "grant the CI key publish-only"
as "$ALICE" grant "$PROJECT" "$CI_ADDR" --permission publish

step "CI ships v2 but cannot touch production"
as "$CI" deploy "$PROJECT" "$WORK/v2.html"
V2=$(navik resolve "$PROJECT-v2" | awk '{print $3}')
fails as "$CI" promote "$PROJECT" v2
live_is "$V1"

step "grant CI promote; CI promotes v2"
as "$ALICE" grant "$PROJECT" "$CI_ADDR" --permission promote
as "$CI" promote "$PROJECT" v2
live_is "$V2"

step "roll back to v1 (one ENS write, no upload)"
as "$ALICE" rollback "$PROJECT" v1
live_is "$V1"

step "list releases"
navik ls "$PROJECT"

step "verify production and a release name"
navik verify "$PROJECT"
navik verify "$PROJECT-v2.navik.eth" --out "$WORK/fetched.html"
cmp "$WORK/fetched.html" "$WORK/v2.html" && echo "  fetched bytes == uploaded bytes"

step "multi-chunk: a ~70 KB site is uploaded in batches, then published"
{ printf '<!doctype html><title>%s</title><pre>' "$PROJECT"; head -c 52000 /dev/urandom | base64 -w 120; printf '</pre>'; } > "$WORK/big.html"
as "$ALICE" deploy "$PROJECT" "$WORK/big.html" | tee "$WORK/out"
grep -q "chunks       3 (0 already stored, 3 new)" "$WORK/out"
navik verify "$PROJECT-v3" --out "$WORK/big-fetched.html"
cmp "$WORK/big-fetched.html" "$WORK/big.html" && echo "  fetched bytes == uploaded bytes ($(wc -c < "$WORK/big.html") B)"

step "multi-chunk: changing the end of the site re-uploads only the last chunk"
{ head -c 60000 "$WORK/big.html"; printf '<!-- v4 -->'; } > "$WORK/big2.html"
as "$ALICE" deploy "$PROJECT" "$WORK/big2.html" --promote | tee "$WORK/out"
grep -q "chunks       3 (2 already stored, 1 new)" "$WORK/out"
navik verify "$PROJECT" --out "$WORK/big2-fetched.html"
cmp "$WORK/big2-fetched.html" "$WORK/big2.html" && echo "  fetched bytes == uploaded bytes"
as "$ALICE" rollback "$PROJECT" v1

step "compressed: a ~100 KB site stored gzip-wrapped in fewer chunks"
{ printf '<!doctype html><title>%s</title><ol>' "$PROJECT"; for i in $(seq 1 2500); do printf '<li>row %d of a fairly repetitive table</li>' "$i"; done; printf '</ol>'; } > "$WORK/zip.html"
as "$ALICE" deploy "$PROJECT" "$WORK/zip.html" --compress | tee "$WORK/out"
grep -Eq "compressed   [0-9]+ → [0-9]+ bytes \([0-9]+ → 1 chunks\)" "$WORK/out"
navik verify "$PROJECT-v5" --out "$WORK/zip-fetched.html" | tee "$WORK/out"
grep -q "gzip-wrapped: original" "$WORK/out"
cmp "$WORK/zip-fetched.html" "$WORK/zip.html" && echo "  decompressed bytes == original bytes ($(wc -c < "$WORK/zip.html") B)"
navik verify "$PROJECT-v5" --raw --out "$WORK/zip-raw.html" >/dev/null
base64 -d <<<"$(grep -o 'atob("[^"]*")' "$WORK/zip-raw.html" | sed 's/atob("//; s/")$//')" | gunzip | cmp - "$WORK/zip.html" \
  && echo "  stored loader decodes with standard tools: base64 -d | gunzip"

step "open from Ethereum"
navik open "$PROJECT"

step "revoke CI: its next deploy and promote are rejected"
as "$ALICE" revoke "$PROJECT" "$CI_ADDR" --permission publish
as "$ALICE" revoke "$PROJECT" "$CI_ADDR" --permission promote
fails as "$CI" deploy "$PROJECT" "$WORK/v2.html"
fails as "$CI" promote "$PROJECT" v2

step "isolation: alice's CI key is useless on another project"
as "$MALLORY" claim "${PROJECT}-blog"
as "$ALICE" grant "$PROJECT" "$CI_ADDR" --permission publish
fails as "$CI" deploy "${PROJECT}-blog" "$WORK/v1.html"

step "the navik.eth team cannot publish to or repoint a user's project"
fails as "$TEAM" deploy "$PROJECT" "$WORK/v2.html"
fails as "$TEAM" promote "$PROJECT" v2
fails as "$MALLORY" promote "$PROJECT" v2

step "demote: production cleared, releases stay"
as "$ALICE" demote "$PROJECT"
live_is "(none)"
navik verify "$PROJECT-v1"

step "release-shaped labels cannot be claimed"
fails as "$MALLORY" claim "$PROJECT-v9"

printf '\n\033[32mall e2e checks passed\033[0m\n'
