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
import {NavikHooks} from "./libraries/NavikHooks.sol";
import {NavikNames} from "./libraries/NavikNames.sol";
import {NavikFactory} from "./NavikFactory.sol";

/// Hands out `<project>.navik.eth`.
///
/// Creates the Navik ENSv2 UserRegistry in its constructor and keeps only ROLE_REGISTRAR on it:
/// nobody holds upgrade, unregister, set-resolver or set-subregistry at root, and the parent is
/// locked, so no admin can take a project name away, repoint it, or upgrade the registry.
/// It also deploys the NavikFactory, and claims the root project (e.g. `app`, whose production
/// navik.eth itself follows) so nobody can front-run it.
///
/// Each project gets:
/// - its own Permissioned Resolver (one EAC scope per project) where the claimer is the only
///   role holder: production lives here as `text("contentcontract")`, and `contenthash` starts
///   as a hook on NavikPages, so gateways like eth.limo serve production (the owner can change it);
/// - its own UserRegistry for `<N>.<project>` release names. The factory is its only registrar;
///   the parent is locked and nothing else is granted, so it is emancipated. `preview` is
///   registered up front, held by the factory, which may only repoint its resolver.
/// The owner cannot change the project's subregistry, so release names can never be hidden.
/// The registrar keeps no role anywhere.
contract NavikRegistrar {
    error InvalidLabel(string label);
    error LabelTaken(string label);

    event ProjectClaimed(
        bytes32 indexed node,
        string label,
        address indexed owner,
        address resolver,
        address releaseRegistry,
        uint256 tokenId
    );

    /// Roles the project owner gets on their name: choose its resolver, transfer it. No subregistry
    /// change (release names stay), no unregister and no expiry (project names are permanent).
    uint256 public constant OWNER_ROLES =
        ENSv2Roles.ROLE_SET_RESOLVER | ENSv2Roles.ROLE_SET_RESOLVER_ADMIN | ENSv2Roles.ROLE_CAN_TRANSFER_ADMIN;
    uint64 public constant EXPIRY = type(uint64).max;
    uint256 public constant REGISTRY_SALT = uint256(keccak256("navik.registry"));
    /// Roles the registrar holds only while setting up a registry, then revokes.
    uint256 internal constant SETUP_ROLES = ENSv2Roles.ROLE_REGISTRAR | ENSv2Roles.ROLE_REGISTRAR_ADMIN
        | ENSv2Roles.ROLE_SET_PARENT | ENSv2Roles.ROLE_SET_PARENT_ADMIN;
    uint256 internal constant LOCK_PARENT = ENSv2Roles.ROLE_SET_PARENT | ENSv2Roles.ROLE_SET_PARENT_ADMIN;

    IVerifiableFactory public immutable VERIFIABLE_FACTORY;
    address public immutable USER_REGISTRY_IMPL;
    address public immutable RESOLVER_IMPL;
    IPermissionedRegistry public immutable REGISTRY;
    NavikFactory public immutable FACTORY;
    bytes32 public immutable ROOT_NODE;
    /// Serves project names to gateways, through each project's `contenthash`.
    address public immutable PAGES;
    /// `navik.eth`
    string public rootName;

    constructor(
        IVerifiableFactory verifiableFactory,
        address userRegistryImpl,
        address resolverImpl,
        address parentRegistry,
        string memory rootLabel,
        bytes32 rootNode,
        string memory rootProject,
        address rootProjectOwner,
        address pages
    ) {
        VERIFIABLE_FACTORY = verifiableFactory;
        USER_REGISTRY_IMPL = userRegistryImpl;
        RESOLVER_IMPL = resolverImpl;
        ROOT_NODE = rootNode;
        PAGES = pages;
        string memory root = string.concat(rootLabel, ".eth");
        rootName = root;

        // the Navik registry: keep REGISTRAR, set and lock the parent
        IPermissionedRegistry registry =
            _newRegistry(verifiableFactory, userRegistryImpl, REGISTRY_SALT, ENSv2Roles.ROLE_REGISTRAR | LOCK_PARENT);
        registry.setParent(parentRegistry, rootLabel);
        registry.revokeRootRoles(LOCK_PARENT, address(this));
        REGISTRY = registry;

        NavikFactory factory = new NavikFactory(registry, rootNode);
        FACTORY = factory;
        _claim(registry, factory, rootNode, root, pages, rootProject, rootProjectOwner);
    }

    function claim(string calldata label, address owner)
        external
        returns (address resolver, address releaseRegistry, uint256 tokenId)
    {
        return _claim(REGISTRY, FACTORY, ROOT_NODE, rootName, PAGES, label, owner);
    }

    /// Resolver a claim of `label` would create (deterministic per label).
    function predictResolver(string calldata label) external view returns (address) {
        return VERIFIABLE_FACTORY.predictProxyAddress(address(this), uint256(NavikNames.node(ROOT_NODE, label)));
    }

    /// Takes immutables as arguments: they cannot be read in the constructor.
    function _claim(
        IPermissionedRegistry registry,
        NavikFactory factory,
        bytes32 rootNode,
        string memory root,
        address pages,
        string memory label,
        address owner
    ) internal returns (address resolver, address releaseRegistry, uint256 tokenId) {
        if (!NavikNames.isValidProjectLabel(label)) revert InvalidLabel(label);
        if (registry.getOwner(uint256(keccak256(bytes(label)))) != address(0)) revert LabelTaken(label);
        bytes32 node = NavikNames.node(rootNode, label);

        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(owner, ENSv2Roles.ALL_ROLES);
        string memory name = string.concat(label, ".", root);
        bytes[] memory records = new bytes[](1);
        records[0] = abi.encodeCall(
            IPermissionedResolver.setContenthash,
            (
                NavikNames.dnsEncode(name),
                NavikHooks.contenthash("page(string)", string.concat("page('", name, "')"), pages)
            )
        );
        resolver = VERIFIABLE_FACTORY.deployProxy(
            RESOLVER_IMPL, uint256(node), abi.encodeCall(IPermissionedResolver.initialize, (grants, records))
        );
        releaseRegistry = address(_newReleaseRegistry(registry, factory, node, label));
        tokenId = registry.register(label, owner, releaseRegistry, resolver, OWNER_ROLES, EXPIRY);

        emit ProjectClaimed(node, label, owner, resolver, releaseRegistry, tokenId);
    }

    /// The project's registry for `<N>.<project>`: parent locked, `preview` reserved for the
    /// factory (which may only repoint its resolver), the factory as sole registrar, and no
    /// role left for the registrar.
    function _newReleaseRegistry(IPermissionedRegistry parent, NavikFactory factory, bytes32 node, string memory label)
        internal
        returns (IPermissionedRegistry releases)
    {
        releases = _newRegistry(
            VERIFIABLE_FACTORY, USER_REGISTRY_IMPL, uint256(keccak256(abi.encode("navik.releases", node))), SETUP_ROLES
        );
        releases.setParent(address(parent), label);
        releases.register(
            factory.PREVIEW_LABEL(), address(factory), address(0), address(0), ENSv2Roles.ROLE_SET_RESOLVER, EXPIRY
        );
        releases.grantRootRoles(ENSv2Roles.ROLE_REGISTRAR, address(factory));
        releases.revokeRootRoles(SETUP_ROLES, address(this));
    }

    function _newRegistry(IVerifiableFactory verifiableFactory, address impl, uint256 salt, uint256 roles)
        internal
        returns (IPermissionedRegistry)
    {
        Grant[] memory grants = new Grant[](1);
        grants[0] = Grant(address(this), roles);
        return IPermissionedRegistry(
            verifiableFactory.deployProxy(impl, salt, abi.encodeCall(IUserRegistryInitializable.initialize, (grants)))
        );
    }
}
