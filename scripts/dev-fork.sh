#!/usr/bin/env bash
# Local mainnet fork with Navik deployed: anvil on :8545 (chain id 31337).
# navik.eth goes to anvil account #0: registered by impersonating ENSv2's ETHRegistrar (same
# roles as a real purchase) or, if it is already owned on mainnet, transferred on the fork by
# impersonating its owner. Then Deploy.s.sol attaches it (not frozen).
# FREEZE=1 also runs Freeze.s.sol, removing the power to repoint navik.eth.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAINNET_RPC_URL="${MAINNET_RPC_URL:-https://eth.drpc.org}"
RPC=http://127.0.0.1:8545
ROOT_LABEL="${ROOT_LABEL:-navik}"
# anvil default account #0
OWNER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
OWNER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ETH_REGISTRY=0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2
ETH_REGISTRAR=0xD6D8369e55c94Ae8AFA714E6cF7AB5bE54D5CC81
# ETHRegistrar.REGISTRATION_ROLE_BITMAP: set subregistry/resolver (+ admins), can transfer
ETH_OWNER_ROLES=$(python3 -c 'print((1<<20)|((1<<20)<<128)|(1<<24)|((1<<24)<<128)|((1<<28)<<128))')

if ! cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  anvil --fork-url "$MAINNET_RPC_URL" --chain-id 31337 --silent >/dev/null 2>&1 &
  echo $! > "$ROOT_DIR/.anvil.pid"
  for _ in $(seq 1 50); do cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break; sleep 0.2; done
fi

# anvil's well-known dev accounts carry EIP-7702 delegations on mainnet; make them plain EOAs
for i in 0 1 2 3; do
  cast rpc anvil_setCode "$(cast wallet address --mnemonic "test test test test test test test test test test test junk" --mnemonic-index $i)" 0x --rpc-url "$RPC" >/dev/null
done

LABEL_ID=$(cast keccak "$ROOT_LABEL")
CURRENT=$(cast call "$ETH_REGISTRY" "getOwner(uint256)(address)" "$LABEL_ID" --rpc-url "$RPC")
if [[ "$CURRENT" == "0x0000000000000000000000000000000000000000" ]]; then
  # not registered on mainnet yet: register it as ETHRegistrar would after a purchase
  cast rpc anvil_impersonateAccount "$ETH_REGISTRAR" --rpc-url "$RPC" >/dev/null
  cast rpc anvil_setBalance "$ETH_REGISTRAR" 0xde0b6b3a7640000 --rpc-url "$RPC" >/dev/null
  EXPIRY=$(( $(date +%s) + 10 * 365 * 86400 ))
  cast send "$ETH_REGISTRY" "register(string,address,address,address,uint256,uint64)" \
    "$ROOT_LABEL" "$OWNER" 0x0000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000 \
    "$ETH_OWNER_ROLES" "$EXPIRY" --from "$ETH_REGISTRAR" --unlocked --rpc-url "$RPC" >/dev/null
  cast rpc anvil_stopImpersonatingAccount "$ETH_REGISTRAR" --rpc-url "$RPC" >/dev/null
elif [[ "$(cast to-check-sum-address "$CURRENT")" != "$OWNER" ]]; then
  # already owned on mainnet: on the fork only, have the real owner transfer it (roles move with it)
  TOKEN_ID=$(cast call "$ETH_REGISTRY" "getTokenId(uint256)(uint256)" "$LABEL_ID" --rpc-url "$RPC" | awk '{print $1}')
  cast rpc anvil_impersonateAccount "$CURRENT" --rpc-url "$RPC" >/dev/null
  cast rpc anvil_setBalance "$CURRENT" 0xde0b6b3a7640000 --rpc-url "$RPC" >/dev/null
  cast send "$ETH_REGISTRY" "safeTransferFrom(address,address,uint256,uint256,bytes)" \
    "$CURRENT" "$OWNER" "$TOKEN_ID" 1 0x --from "$CURRENT" --unlocked --rpc-url "$RPC" >/dev/null
  cast rpc anvil_stopImpersonatingAccount "$CURRENT" --rpc-url "$RPC" >/dev/null
  echo "(fork only) moved $ROOT_LABEL.eth from its mainnet owner $CURRENT"
fi
echo "$ROOT_LABEL.eth owned by $OWNER on the fork"

cd "$ROOT_DIR/contracts"
ROOT_LABEL="$ROOT_LABEL" forge script script/Deploy.s.sol --rpc-url "$RPC" --private-key "$OWNER_KEY" --broadcast --slow -q
if [[ "${FREEZE:-0}" == "1" ]]; then
  ROOT_LABEL="$ROOT_LABEL" CONFIRM_FREEZE="$ROOT_LABEL.eth" \
    forge script script/Freeze.s.sol --rpc-url "$RPC" --private-key "$OWNER_KEY" --broadcast --slow -q
fi
cat deployments/31337.json && echo
