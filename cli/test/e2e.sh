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
V1=$(navik resolve "1.$PROJECT" | awk '{print $3}')
live_is "$V1"

step "grant the CI key publish-only"
as "$ALICE" grant "$PROJECT" "$CI_ADDR" --permission publish

step "CI ships v2 but cannot touch production"
as "$CI" deploy "$PROJECT" "$WORK/v2.html"
V2=$(navik resolve "2.$PROJECT" | awk '{print $3}')
[[ "$(navik resolve "preview.$PROJECT")" == *"$V2"* ]] || { echo "preview did not follow v2" >&2; exit 1; }
echo "  preview.$PROJECT.navik.eth follows the newest release"
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
navik verify "2.$PROJECT.navik.eth" --out "$WORK/fetched.html"
cmp "$WORK/fetched.html" "$WORK/v2.html" && echo "  fetched bytes == uploaded bytes"

step "multi-chunk: a ~70 KB site is uploaded in batches, then published"
{ printf '<!doctype html><title>%s</title><pre>' "$PROJECT"; head -c 52000 /dev/urandom | base64 -w 120; printf '</pre>'; } > "$WORK/big.html"
as "$ALICE" deploy "$PROJECT" "$WORK/big.html" | tee "$WORK/out"
grep -q "chunks       3 (0 already stored, 3 new)" "$WORK/out"
navik verify "3.$PROJECT" --out "$WORK/big-fetched.html"
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
navik verify "5.$PROJECT" --out "$WORK/zip-fetched.html" | tee "$WORK/out"
grep -q "gzip-wrapped: original" "$WORK/out"
cmp "$WORK/zip-fetched.html" "$WORK/zip.html" && echo "  decompressed bytes == original bytes ($(wc -c < "$WORK/zip.html") B)"
navik verify "5.$PROJECT" --against "$WORK/zip.html" | grep -q "byte-identical to the original document" \
  && echo "  --against: the local build matches the release"
if navik verify "5.$PROJECT" --against "$WORK/big.html" >/dev/null; then
  echo "verify --against a different file should fail" >&2
  exit 1
fi
echo "  --against: a different build is rejected"
navik verify "5.$PROJECT" --raw --out "$WORK/zip-raw.html" >/dev/null
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
navik verify "1.$PROJECT"

step "release names are subnames of the project, not claimable labels"
fails as "$MALLORY" claim "9.$PROJECT"
navik resolve "9.$PROJECT" | grep -q "(none)" || { echo "9.$PROJECT should not resolve" >&2; exit 1; }
echo "  9.$PROJECT.navik.eth does not exist yet"

step "directory build: navik.json builds the viem + React example, packs dist/ and smoke-tests it"
EXAMPLE="$ROOT_DIR/examples/viem-vite"
VITE="${PROJECT}-vite"
as "$ALICE" claim "$VITE" >/dev/null
(cd "$EXAMPLE" && as "$ALICE" deploy "$VITE" --smoke --promote --json) > "$WORK/deploy.json" 2> "$WORK/out"
grep -E "^(packed|compressed|segments|smoke|release)" "$WORK/out"
grep -q "^segments     5 asset(s) in chunks of their own" "$WORK/out"
json() { node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1]));console.log(r[process.argv[2]])' "$1" "$2"; }
[[ "$(json "$WORK/deploy.json" published)" == true && "$(json "$WORK/deploy.json" promoted)" == true ]] \
  || { cat "$WORK/deploy.json"; echo "expected a published, promoted release" >&2; exit 1; }
[[ "$(navik resolve "$VITE")" == *"$(json "$WORK/deploy.json" address)"* ]] || { echo "$VITE is not live" >&2; exit 1; }
navik verify "$VITE" --against "$EXAMPLE/dist" | grep -q "dist is byte-identical to the original document"
echo "  --against dist/: packing the build again gives the bytes production serves"

step "CI re-runs: unchanged bytes publish nothing, and report it to GitHub Actions"
export GITHUB_OUTPUT="$WORK/gh-output" GITHUB_STEP_SUMMARY="$WORK/gh-summary"
(cd "$EXAMPLE" && as "$ALICE" deploy "$VITE" --skip-build --promote --json) > "$WORK/deploy.json" 2>/dev/null
unset GITHUB_OUTPUT GITHUB_STEP_SUMMARY
[[ "$(json "$WORK/deploy.json" unchanged)" == true && "$(json "$WORK/deploy.json" transactions)" == "[]" ]] \
  || { cat "$WORK/deploy.json"; echo "expected no transactions" >&2; exit 1; }
grep -q "^release=1.$VITE.navik.eth$" "$WORK/gh-output" && grep -q "^unchanged=true$" "$WORK/gh-output"
grep -q "unchanged, nothing published" "$WORK/gh-summary"
echo "  no transactions; step outputs and job summary written"
(cd "$EXAMPLE" && fails as "$ALICE" deploy "$VITE" --skip-build --force --max-gas-price 0.000000001)

step "a code-split build is rejected before anything is sent"
mkdir -p "$WORK/split/assets"
printf '<!doctype html><script type="module" src="/assets/index.js"></script>' > "$WORK/split/index.html"
printf 'import("./page.js")' > "$WORK/split/assets/index.js"
printf 'export default 1' > "$WORK/split/assets/page.js"
fails as "$ALICE" deploy "$VITE" "$WORK/split"

if [[ -n "${ARKIV_PRIVATE_KEY:-}" ]]; then
  # Writes go to Arkiv's testnet (Rabdi), so the key needs tGLM there; Swarm is a local stand-in
  # for the bee API (no postage batch needed).
  step "provenance: deploy builds from navik.json, records the source on Arkiv and puts it on Swarm"
  BUILDER=$ARKIV_PRIVATE_KEY
  BUILDER_ADDR=$(address "$BUILDER")
  cast rpc anvil_setBalance "$BUILDER_ADDR" 0x8ac7230489e80000 --rpc-url "$RPC_URL" >/dev/null
  as "$ALICE" grant "$PROJECT" "$BUILDER_ADDR" --permission publish
  SRC="$WORK/src"
  mkdir -p "$SRC"
  git -C "$SRC" init -q
  printf '<!doctype html><title>%s</title><link rel="stylesheet" href="/assets/site.css"><h1>built from source</h1><script src="/assets/site.js"></script>' "$PROJECT" > "$SRC/page.html"
  printf 'h1{color:teal}' > "$SRC/site.css"
  printf 'document.title+=" ✓"' > "$SRC/site.js"
  BUILD='mkdir -p dist/assets && cp page.html dist/index.html && cp site.css site.js dist/assets/'
  printf '{"project":"%s","build":"%s","output":"dist"}' "$PROJECT" "$BUILD" > "$SRC/navik.json"
  git -C "$SRC" add .
  git -C "$SRC" -c user.name=e2e -c user.email=e2e@navik.invalid commit -qm site
  git -C "$SRC" remote add origin "file://$SRC"
  SWARM_PORT=18633
  node "$CLI_DIR/test/swarm-stub.ts" "$SWARM_PORT" >/dev/null &
  STUB=$!
  trap 'kill $STUB 2>/dev/null' EXIT
  sleep 0.5
  export SWARM_API="http://127.0.0.1:$SWARM_PORT" SWARM_BATCH="0x$(printf '0%.0s' {1..64})"
  (cd "$SRC" && as "$BUILDER" deploy --provenance --swarm --notes "e2e $PROJECT") | tee "$WORK/out"
  RELEASE=$(awk '/^release/ {print $2}' "$WORK/out")
  grep -q "^provenance   file://$SRC @ " "$WORK/out"

  step "provenance is read back from Arkiv and trusted: its writer published the release"
  navik provenance "$RELEASE" | tee "$WORK/out"
  grep -q "written by $BUILDER_ADDR, the publisher" "$WORK/out"
  grep -q "→  dist/$" "$WORK/out"
  grep -q "reproduced by 0 builder(s)" "$WORK/out"

  step "reproduce from Swarm (hash-checked), rebuild, pack dist/, compare, attest"
  fails navik reproduce "$RELEASE"
  as "$BUILDER" reproduce "$RELEASE" --yes --attest | tee "$WORK/out"
  grep -q "keccak256 matches the provenance" "$WORK/out"
  grep -q "byte-identical to $RELEASE" "$WORK/out"
  grep -q "attested on Arkiv: entity 0x" "$WORK/out"

  step "reproduce from git instead"
  navik reproduce "$RELEASE" --yes --git | grep -q "byte-identical to $RELEASE" && echo "  git checkout rebuilds the same bytes"

  step "the attestation is listed, keyed by content"
  navik provenance "$RELEASE" | tee "$WORK/out"
  grep -q "reproduced by 1 builder(s)" "$WORK/out"

  step "anyone may extend the records"
  as "$BUILDER" keep-alive "$RELEASE" | grep -q "extended 2 entities"
  echo "  provenance and attestation extended"
fi

printf '\n\033[32mall e2e checks passed\033[0m\n'
