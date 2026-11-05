// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Script, console} from "forge-std/Script.sol";

import {IPermissionedRegistry} from "../src/interfaces/IENSv2.sol";

import {ENSv2Mainnet} from "./ENSv2Mainnet.sol";
import {Navik, NavikDeploy} from "./NavikDeploy.sol";

/// Deploys Navik on mainnet (or a mainnet fork) and writes deployments/<chainId>.json
/// (plus deployments/<chainId>-<block>.json, kept for switching back).
///
/// If the broadcaster owns `<ROOT_LABEL>.eth`, it also points the name at the new contracts.
/// The owner keeps the power to repoint it (to fix mistakes) until Freeze.s.sol is run.
///
///   ROOT_LABEL=navik forge script script/Deploy.s.sol --rpc-url $RPC_URL --private-key $PRIVATE_KEY --broadcast
contract Deploy is Script {
    function run() external {
        string memory rootLabel = vm.envOr("ROOT_LABEL", string("navik"));
        IPermissionedRegistry eth = IPermissionedRegistry(ENSv2Mainnet.ETH_REGISTRY);

        vm.startBroadcast();
        (, address sender,) = vm.readCallers();
        Navik memory n = NavikDeploy.deploy(rootLabel);
        bool owner = eth.getOwner(uint256(keccak256(bytes(rootLabel)))) == sender;
        if (owner) NavikDeploy.attach(n, rootLabel);
        vm.stopBroadcast();

        if (!owner) {
            console.log("broadcaster does not own the root name: run Attach.s.sol from the owner wallet");
        }
        _write(n, rootLabel);
    }

    function _write(Navik memory n, string memory rootLabel) internal {
        string memory k = "deployment";
        vm.serializeUint(k, "chainId", block.chainid);
        vm.serializeUint(k, "deployBlock", block.number);
        vm.serializeString(k, "root", string.concat(rootLabel, ".eth"));
        vm.serializeBytes32(k, "rootNode", n.rootNode);
        vm.serializeAddress(k, "registrar", address(n.registrar));
        vm.serializeAddress(k, "registry", address(n.registry));
        vm.serializeAddress(k, "factory", address(n.factory));
        vm.serializeAddress(k, "resolver", address(n.resolver));
        vm.serializeAddress(k, "ethRegistry", ENSv2Mainnet.ETH_REGISTRY);
        string memory json = vm.serializeAddress(k, "universalResolver", ENSv2Mainnet.UNIVERSAL_RESOLVER);
        string memory dir = string.concat(vm.projectRoot(), "/deployments/");
        string memory id = vm.toString(block.chainid);
        // current deployment (read by the CLI) plus a per-block copy to switch back to with Attach.s.sol
        vm.writeJson(json, string.concat(dir, id, ".json"));
        vm.writeJson(json, string.concat(dir, id, "-", vm.toString(block.number), ".json"));
        console.log("wrote", string.concat(dir, id, ".json"));
    }
}
