// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console} from "forge-std/Script.sol";

import {NavikDeploy} from "./NavikDeploy.sol";

/// Points `<ROOT_LABEL>.eth` at an existing Navik deployment and makes it the current one
/// (deployments/<chainId>.json). Use it to switch between deployments during testing.
/// Fails once the name is frozen.
///
///   DEPLOYMENT=1-24000000 forge script script/Attach.s.sol --rpc-url $RPC_URL --private-key $OWNER_KEY --broadcast
contract Attach is Script {
    function run() external {
        string memory rootLabel = vm.envOr("ROOT_LABEL", string("navik"));
        string memory dir = string.concat(vm.projectRoot(), "/deployments/");
        string memory current = string.concat(dir, vm.toString(block.chainid), ".json");
        string memory path = string.concat(dir, vm.envOr("DEPLOYMENT", vm.toString(block.chainid)), ".json");
        string memory json = vm.readFile(path);
        address registry = vm.parseJsonAddress(json, ".registry");
        address resolver = vm.parseJsonAddress(json, ".resolver");

        vm.startBroadcast();
        NavikDeploy.attach(rootLabel, registry, resolver);
        vm.stopBroadcast();
        vm.writeFile(current, json);
        console.log("attached", path);
    }
}
