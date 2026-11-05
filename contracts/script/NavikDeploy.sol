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

    /// Roles on navik.eth that can repoint the whole namespace. Held by the owner during
    /// testing so mistakes can be fixed; `freeze` removes them for good.
    uint256 internal constant ROOT_CONTROL_ROLES = ENSv2Roles.ROLE_SET_SUBREGISTRY
        | ENSv2Roles.ROLE_SET_SUBREGISTRY_ADMIN | ENSv2Roles.ROLE_SET_RESOLVER | ENSv2Roles.ROLE_SET_RESOLVER_ADMIN;

    /// Deploys the Navik contracts for `<rootLabel>.eth`. Needs no special permissions.
    /// `rootProject` (claimed for `rootProjectOwner`) is the project navik.eth itself serves.
    function deploy(string memory rootLabel, string memory rootProject, address rootProjectOwner)
        internal
        returns (Navik memory n)
    {
        n.rootNode = NavikNames.node(ETH_NODE, rootLabel);
        n.registrar = new NavikRegistrar(
            IVerifiableFactory(ENSv2Mainnet.VERIFIABLE_FACTORY),
            ENSv2Mainnet.USER_REGISTRY_IMPL,
            ENSv2Mainnet.PERMISSIONED_RESOLVER_IMPL,
            ENSv2Mainnet.ETH_REGISTRY,
            rootLabel,
            n.rootNode,
            rootProject,
            rootProjectOwner
        );
        n.registry = n.registrar.REGISTRY();
        n.factory = new NavikFactory(n.registry, n.rootNode);
        n.resolver = new NavikResolver(n.factory, rootProject);
    }

    /// Must be sent by an account holding the root control roles (the navik.eth owner):
    /// points navik.eth at the Navik registry and resolver. Can be repeated to fix mistakes
    /// until the name is frozen.
    function attach(Navik memory n, string memory rootLabel) internal {
        attach(rootLabel, address(n.registry), address(n.resolver));
    }

    function attach(string memory rootLabel, address registry, address resolver) internal {
        IPermissionedRegistry eth = IPermissionedRegistry(ENSv2Mainnet.ETH_REGISTRY);
        uint256 id = uint256(keccak256(bytes(rootLabel)));
        eth.setSubregistry(id, registry);
        eth.setResolver(id, resolver);
    }

    /// Irreversible. Sent by `caller` (the navik.eth owner): revokes the root control roles, and
    /// their admin roles so they cannot be granted again, from every account in `others` and
    /// then from `caller` (last, since its admin roles are what allow revoking the others).
    /// Requires that nobody holds them afterwards: nobody can repoint navik.eth again.
    function freeze(string memory rootLabel, address caller, address[] memory others) internal {
        IPermissionedRegistry eth = IPermissionedRegistry(ENSv2Mainnet.ETH_REGISTRY);
        uint256 id = uint256(keccak256(bytes(rootLabel)));
        for (uint256 i; i < others.length; ++i) {
            eth.revokeRoles(id, ROOT_CONTROL_ROLES, others[i]);
        }
        eth.revokeRoles(id, ROOT_CONTROL_ROLES, caller);
        require(isFrozen(rootLabel), "freeze: other accounts still hold root control roles");
    }

    /// True once no account can repoint `<rootLabel>.eth`: nobody holds the control roles on
    /// the token, and the ETHRegistry has no root override (emancipated).
    function isFrozen(string memory rootLabel) internal view returns (bool) {
        IPermissionedRegistry eth = IPermissionedRegistry(ENSv2Mainnet.ETH_REGISTRY);
        uint256 counts = eth.roleCount(uint256(keccak256(bytes(rootLabel))));
        // roleCount packs one 4-bit assignee count per role nybble
        return counts & (ROOT_CONTROL_ROLES * 0xf) == 0 && eth.isEmancipated();
    }
}
