// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {
    ENSv2Roles,
    Grant,
    IPermissionedRegistry,
    IPermissionedResolver,
    IUserRegistryInitializable,
    IVerifiableFactory
} from "./interfaces/IENSv2.sol";
import {NavikNames} from "./libraries/NavikNames.sol";

/// Hands out `<project>.navik.eth`.
///
/// Creates the Navik ENSv2 UserRegistry in its constructor with exactly one root grant:
/// ROLE_REGISTRAR (+ ROLE_SET_PARENT, used once below) to this contract. Nobody holds
/// upgrade, unregister, set-resolver or set-subregistry at root, so no admin can take a
/// project name away, repoint it, or upgrade the registry.
///
/// Every project gets its own Permissioned Resolver (one EAC scope per project) where the
/// claimer is the only role holder. The registrar keeps nothing.
contract NavikRegistrar {
    error InvalidLabel(string label);
    error LabelTaken(string label);

    event ProjectClaimed(bytes32 indexed node, string label, address indexed owner, address resolver, uint256 tokenId);

    /// Roles the project owner gets on their name. No ROLE_UNREGISTER and no expiry:
    /// project names are permanent.
    uint256 public constant OWNER_ROLES = ENSv2Roles.ROLE_SET_RESOLVER | ENSv2Roles.ROLE_SET_RESOLVER_ADMIN
        | ENSv2Roles.ROLE_SET_SUBREGISTRY | ENSv2Roles.ROLE_SET_SUBREGISTRY_ADMIN | ENSv2Roles.ROLE_CAN_TRANSFER_ADMIN;
    uint64 public constant EXPIRY = type(uint64).max;
    uint256 public constant REGISTRY_SALT = uint256(keccak256("navik.registry"));

    IVerifiableFactory public immutable VERIFIABLE_FACTORY;
    address public immutable RESOLVER_IMPL;
    IPermissionedRegistry public immutable REGISTRY;
    bytes32 public immutable ROOT_NODE;

    constructor(
        IVerifiableFactory verifiableFactory,
        address userRegistryImpl,
        address resolverImpl,
        address parentRegistry,
        string memory rootLabel,
        bytes32 rootNode
    ) {
        VERIFIABLE_FACTORY = verifiableFactory;
        RESOLVER_IMPL = resolverImpl;
        ROOT_NODE = rootNode;

        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(address(this), ENSv2Roles.ROLE_REGISTRAR | ENSv2Roles.ROLE_SET_PARENT);
        IPermissionedRegistry registry = IPermissionedRegistry(
            verifiableFactory.deployProxy(
                userRegistryImpl, REGISTRY_SALT, abi.encodeCall(IUserRegistryInitializable.initialize, (grants))
            )
        );
        registry.setParent(parentRegistry, rootLabel);
        REGISTRY = registry;
    }

    function claim(string calldata label, address owner) external returns (address resolver, uint256 tokenId) {
        if (!NavikNames.isValidProjectLabel(label)) revert InvalidLabel(label);
        if (REGISTRY.getOwner(uint256(keccak256(bytes(label)))) != address(0)) revert LabelTaken(label);
        bytes32 node = NavikNames.node(ROOT_NODE, label);

        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(owner, ENSv2Roles.ALL_ROLES);
        resolver = VERIFIABLE_FACTORY.deployProxy(
            RESOLVER_IMPL, uint256(node), abi.encodeCall(IPermissionedResolver.initialize, (grants, new bytes[](0)))
        );
        tokenId = REGISTRY.register(label, owner, address(0), resolver, OWNER_ROLES, EXPIRY);

        emit ProjectClaimed(node, label, owner, resolver, tokenId);
    }

    /// Resolver a claim of `label` would create (deterministic per label).
    function predictResolver(string calldata label) external view returns (address) {
        return VERIFIABLE_FACTORY.predictProxyAddress(address(this), uint256(NavikNames.node(ROOT_NODE, label)));
    }
}
