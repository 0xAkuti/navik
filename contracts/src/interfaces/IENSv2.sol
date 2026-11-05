// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// Minimal interfaces matching the verified ENSv2 contracts deployed on mainnet.
/// Do not replace with ensdomains/contracts-v2 main: it differs from what is deployed.

struct Grant {
    address account;
    uint256 roleBitmap;
}

interface IRegistry {
    function getSubregistry(string calldata label) external view returns (address);
    function getResolver(string calldata label) external view returns (address);
}

interface IPermissionedRegistry is IRegistry {
    function register(
        string calldata label,
        address owner,
        address registry,
        address resolver,
        uint256 roleBitmap,
        uint64 expiry
    ) external returns (uint256 tokenId);
    function setSubregistry(uint256 anyId, address registry) external;
    function setResolver(uint256 anyId, address resolver) external;
    function setParent(address parent, string calldata label) external;
    function getOwner(uint256 anyId) external view returns (address);
    function getExpiry(uint256 anyId) external view returns (uint64);
    function getTokenId(uint256 anyId) external view returns (uint256);
    function roles(uint256 anyId, address account) external view returns (uint256);
    function hasRoles(uint256 anyId, uint256 roleBitmap, address account) external view returns (bool);
    function hasRootRoles(uint256 roleBitmap, address account) external view returns (bool);
    function grantRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function revokeRootRoles(uint256 roleBitmap, address account) external returns (bool);
    function getParent() external view returns (address parent, string memory label);
    function getResource(uint256 anyId) external view returns (uint256);
    function grantRoles(uint256 anyId, uint256 roleBitmap, address account) external returns (bool);
    function revokeRoles(uint256 anyId, uint256 roleBitmap, address account) external returns (bool);
    function unregister(uint256 anyId) external;
    function isEmancipated() external view returns (bool);
    function roleCount(uint256 anyId) external view returns (uint256);
}

interface IUserRegistryInitializable {
    function initialize(Grant[] calldata grants) external;
}

interface IPermissionedResolver {
    function initialize(Grant[] calldata grants, bytes[] calldata calls) external;
    function setText(bytes calldata name, string calldata key, string calldata value) external;
    function setAddress(bytes calldata name, uint256 coinType, bytes calldata addressBytes) external;
    function grantSetterRoles(bytes calldata setter, address account) external returns (bool);
    function revokeRoles(uint256 resource, uint256 roleBitmap, address account) external returns (bool);
    function hasRoles(uint256 resource, uint256 roleBitmap, address account) external view returns (bool);
    function linkToNode(bytes calldata sourceName, bytes32 targetNode) external;
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

interface IVerifiableFactory {
    function deployProxy(address implementation, uint256 salt, bytes memory data) external returns (address);
    function predictProxyAddress(address deployer, uint256 salt) external view returns (address);
}

interface IExtendedResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory);
}

/// Role constants copied from the deployed RegistryRolesLib and PermissionedResolverLib.
library ENSv2Roles {
    // registry
    uint256 internal constant ROLE_REGISTRAR = 1 << 0;
    uint256 internal constant ROLE_REGISTRAR_ADMIN = ROLE_REGISTRAR << 128;
    uint256 internal constant ROLE_SET_PARENT = 1 << 8;
    uint256 internal constant ROLE_SET_PARENT_ADMIN = ROLE_SET_PARENT << 128;
    uint256 internal constant ROLE_UNREGISTER = 1 << 12;
    uint256 internal constant ROLE_RENEW = 1 << 16;
    uint256 internal constant ROLE_SET_SUBREGISTRY = 1 << 20;
    uint256 internal constant ROLE_SET_SUBREGISTRY_ADMIN = ROLE_SET_SUBREGISTRY << 128;
    uint256 internal constant ROLE_SET_RESOLVER = 1 << 24;
    uint256 internal constant ROLE_SET_RESOLVER_ADMIN = ROLE_SET_RESOLVER << 128;
    uint256 internal constant ROLE_CAN_TRANSFER_ADMIN = (1 << 28) << 128;
    uint256 internal constant ROLE_UPGRADE = 1 << 124;

    // resolver
    uint256 internal constant ROLE_SET_ADDRESS = 1 << 0;
    uint256 internal constant ROLE_SET_TEXT = 1 << 4;
    uint256 internal constant ROLE_LINK = 1 << 28;

    // every regular and admin role
    uint256 internal constant ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111;
}
