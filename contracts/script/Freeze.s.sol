// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console} from "forge-std/Script.sol";

import {NavikDeploy} from "./NavikDeploy.sol";

/// IRREVERSIBLE. Removes every power to repoint `<ROOT_LABEL>.eth`: afterwards nobody, including
/// the owner, can change which registry and resolver serve the Navik namespace.
///
/// Revokes from the broadcaster plus any extra holders in ALSO_REVOKE (comma-separated), then
/// requires that no account holds the roles anymore. CONFIRM_FREEZE must equal the full name.
///
///   CONFIRM_FREEZE=navik.eth forge script script/Freeze.s.sol --rpc-url $RPC_URL --private-key $OWNER_KEY --broadcast
contract Freeze is Script {
    function run() external {
        string memory rootLabel = vm.envOr("ROOT_LABEL", string("navik"));
        string memory name = string.concat(rootLabel, ".eth");
        require(
            keccak256(bytes(vm.envOr("CONFIRM_FREEZE", string("")))) == keccak256(bytes(name)),
            string.concat("set CONFIRM_FREEZE=", name, " to freeze it forever")
        );
        address[] memory others = vm.envOr("ALSO_REVOKE", ",", new address[](0));

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        NavikDeploy.freeze(rootLabel, sender, others);
        vm.stopBroadcast();
        console.log("frozen", name);
    }
}
