// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {ENSv2Roles, IPermissionedRegistry, IVerifiableFactory} from "../src/interfaces/IENSv2.sol";
import {NavikNames} from "../src/libraries/NavikNames.sol";
import {NavikFactory} from "../src/NavikFactory.sol";
import {NavikRegistrar} from "../src/NavikRegistrar.sol";
import {NavikResolver} from "../src/NavikResolver.sol";

import {ENSv2Mainnet} from "./ENSv2Mainnet.sol";

struct Navik {
    NavikRegistrar registrar;
    IPermissionedRegistry registry;
    NavikFactory factory;
    NavikResolver resolver;
    bytes32 rootNode;
}

library NavikDeploy {
    bytes32 internal constant ETH_NODE = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));

    /// Root roles the .eth owner gives up in `lockRoot`. Afterwards nobody can repoint
    /// navik.eth's registry or resolver (ETHRegistry itself is emancipated).
    uint256 internal constant ROOT_LOCK_ROLES = ENSv2Roles.ROLE_SET_SUBREGISTRY | ENSv2Roles.ROLE_SET_SUBREGISTRY_ADMIN
        | ENSv2Roles.ROLE_SET_RESOLVER | ENSv2Roles.ROLE_SET_RESOLVER_ADMIN;

    /// Deploys the Navik contracts for `<rootLabel>.eth`. Needs no special permissions.
    function deploy(string memory rootLabel) internal returns (Navik memory n) {
        n.rootNode = NavikNames.node(ETH_NODE, rootLabel);
        n.registrar = new NavikRegistrar(
            IVerifiableFactory(ENSv2Mainnet.VERIFIABLE_FACTORY),
            ENSv2Mainnet.USER_REGISTRY_IMPL,
            ENSv2Mainnet.PERMISSIONED_RESOLVER_IMPL,
            ENSv2Mainnet.ETH_REGISTRY,
            rootLabel,
            n.rootNode
        );
        n.registry = n.registrar.REGISTRY();
        n.factory = new NavikFactory(n.registry, n.rootNode);
        n.resolver = new NavikResolver(n.factory);
    }

    /// Must be sent by the owner of `<rootLabel>.eth`: points it at the Navik registry and
    /// resolver, then irrevocably drops the owner's power to change either.
    function attachAndLock(Navik memory n, string memory rootLabel, address rootOwner) internal {
        IPermissionedRegistry eth = IPermissionedRegistry(ENSv2Mainnet.ETH_REGISTRY);
        uint256 id = uint256(keccak256(bytes(rootLabel)));
        eth.setSubregistry(id, address(n.registry));
        eth.setResolver(id, address(n.resolver));
        eth.revokeRoles(id, ROOT_LOCK_ROLES, rootOwner);
    }
}
