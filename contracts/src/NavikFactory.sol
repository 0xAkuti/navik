// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {CREATE3} from "solady/utils/CREATE3.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {LibString} from "solady/utils/LibString.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";

import {Deployment} from "./Deployment.sol";
import {ENSv2Roles, IPermissionedRegistry, IPermissionedResolver} from "./interfaces/IENSv2.sol";
import {NavikChunks} from "./libraries/NavikChunks.sol";
import {NavikNames} from "./libraries/NavikNames.sol";

/// Publishes immutable releases for projects under navik.eth.
///
/// Content is stored as chunks of up to 24,575 bytes (SSTORE2 data contracts, addressed by
/// content, so identical chunks are stored once across all projects). Large sites upload chunks
/// with `storeChunks` over several transactions (mainnet caps a transaction at 2^24 gas, about
/// two full chunks), then `publish` the list of pointers. Small sites can do both at once with
/// `publishContent`. The content hash is computed onchain over the concatenated chunks.
///
/// No owner, no upgrades. Versions are append-only: version N of a project lives at
/// CREATE3(this, keccak(projectNode, N)) and a CREATE3 salt can never be reused.
///
/// Every release also gets a permanent ENSv2 name, `<N>.<project>.navik.eth`, registered in the
/// project's own registry (created by the registrar, where this factory is the only registrar):
/// a token held by this factory with no roles and no expiry, whose resolver is the release
/// itself, so nobody can change, transfer or remove it. `preview.<project>.navik.eth` is
/// repointed to the newest release on every publish.
///
/// Who may publish is decided by ENSv2, not by this contract:
/// - the owner of `<project>.navik.eth` in the Navik registry, or
/// - an account the project's Permissioned Resolver allows to set the `navik.publish` text key
///   (root holders pass automatically; others get it via `grantSetterRoles`).
contract NavikFactory {
    error ProjectNotClaimed(string label);
    error NotPublisher(string label, address account);
    error InvalidContent();
    error InvalidChunk(uint256 index);
    error NoReleaseRegistry(string label);

    event DeploymentPublished(
        bytes32 indexed projectNode,
        uint64 indexed version,
        address indexed deployment,
        string label,
        bytes32 contentHash,
        uint32 size,
        uint16 chunkCount,
        address publisher
    );
    event ChunkStored(address indexed pointer, uint256 size);

    /// EAC resource for the publish capability: keccak256("navik.publish").
    string public constant PUBLISH_KEY = "navik.publish";
    uint256 public constant PUBLISH_RESOURCE = uint256(keccak256(bytes(PUBLISH_KEY)));
    uint256 public constant CHUNK_SIZE = NavikChunks.CHUNK_SIZE;
    /// Keeps `html()` comfortably inside default `eth_call` gas caps (~1.5 MiB).
    uint256 public constant MAX_CHUNKS = 64;
    /// Label of the mutable "latest release" name in every project registry.
    string public constant PREVIEW_LABEL = "preview";

    IPermissionedRegistry public immutable REGISTRY;
    bytes32 public immutable ROOT_NODE;
    address public immutable IMPLEMENTATION;

    mapping(bytes32 projectNode => uint64) public versionCount;

    constructor(IPermissionedRegistry registry, bytes32 rootNode) {
        REGISTRY = registry;
        ROOT_NODE = rootNode;
        IMPLEMENTATION = address(new Deployment());
    }

    /// Stores chunks that are not stored yet. Permissionless: chunks are addressed by content.
    function storeChunks(bytes[] calldata chunks) public returns (address[] memory pointers) {
        pointers = new address[](chunks.length);
        for (uint256 i; i < chunks.length; ++i) {
            bytes calldata c = chunks[i];
            if (c.length == 0 || c.length > CHUNK_SIZE) revert InvalidChunk(i);
            address p = SSTORE2.predictCounterfactualAddress(c, bytes32(0));
            if (p.code.length == 0) {
                SSTORE2.writeCounterfactual(c, bytes32(0));
                emit ChunkStored(p, c.length);
            }
            pointers[i] = p;
        }
    }

    /// Where `chunk` is (or would be) stored.
    function chunkPointer(bytes calldata chunk) external view returns (address) {
        return SSTORE2.predictCounterfactualAddress(chunk, bytes32(0));
    }

    /// Publishes the next version of `label` from already stored chunks, in document order.
    function publish(string calldata label, address[] calldata pointers)
        external
        returns (address deployment, uint64 version)
    {
        _checkPublisher(label, msg.sender);
        return _publish(label, pointers);
    }

    /// Stores `chunks` (skipping existing ones) and publishes them in one transaction.
    function publishContent(string calldata label, bytes[] calldata chunks)
        external
        returns (address deployment, uint64 version)
    {
        _checkPublisher(label, msg.sender);
        return _publish(label, storeChunks(chunks));
    }

    function canPublish(string calldata label, address account) public view returns (bool) {
        address owner = REGISTRY.getOwner(uint256(keccak256(bytes(label))));
        if (owner == address(0)) return false;
        if (account == owner) return true;
        address resolver = REGISTRY.getResolver(label);
        if (resolver.code.length == 0) return false;
        try IPermissionedResolver(resolver).hasRoles(PUBLISH_RESOURCE, ENSv2Roles.ROLE_SET_TEXT, account) returns (
            bool ok
        ) {
            return ok;
        } catch {
            return false;
        }
    }

    function projectNode(string memory label) public view returns (bytes32) {
        return NavikNames.node(ROOT_NODE, label);
    }

    /// Address of version `version` of `node`, whether or not it exists yet.
    function predict(bytes32 node, uint64 version) public view returns (address) {
        return CREATE3.predictDeterministicAddress(_salt(node, version));
    }

    /// Address of an existing version, or zero.
    function deploymentOf(bytes32 node, uint64 version) public view returns (address) {
        if (version == 0 || version > versionCount[node]) return address(0);
        return predict(node, version);
    }

    /// True only for releases created by this factory. Checking `factory()` alone is not enough:
    /// anyone can clone the implementation with forged args, but not at our CREATE3 address.
    function isNavikDeployment(address deployment) external view returns (bool) {
        if (deployment.code.length == 0) return false;
        try Deployment(deployment).projectNode() returns (bytes32 node) {
            try Deployment(deployment).version() returns (uint64 version) {
                return deployment == deploymentOf(node, version);
            } catch {
                return false;
            }
        } catch {
            return false;
        }
    }

    function _publish(string calldata label, address[] memory pointers)
        internal
        returns (address deployment, uint64 version)
    {
        uint256 n = pointers.length;
        if (n == 0 || n > MAX_CHUNKS) revert InvalidContent();
        bytes memory content = NavikChunks.read(pointers); // reverts on missing chunks
        bytes32 contentHash = keccak256(content);
        // forge-lint: disable-next-line(unsafe-typecast) bounded by MAX_CHUNKS * CHUNK_SIZE
        uint32 size = uint32(content.length);

        bytes32 node = projectNode(label);
        version = ++versionCount[node];
        // forge-lint: disable-next-line(unsafe-typecast) bounded by MAX_CHUNKS
        bytes memory args = abi.encodePacked(node, version, contentHash, size, uint16(n), _pack(pointers));
        deployment = CREATE3.deployDeterministic(LibClone.initCode(IMPLEMENTATION, args), _salt(node, version));

        _name(label, version, deployment);
        // forge-lint: disable-next-line(unsafe-typecast) bounded by MAX_CHUNKS
        emit DeploymentPublished(node, version, deployment, label, contentHash, size, uint16(n), msg.sender);
    }

    /// Registers `<version>.<label>.navik.eth` (forever, no roles, resolver = the release) and
    /// repoints `preview.<label>.navik.eth` to it.
    function _name(string calldata label, uint64 version, address deployment) internal {
        IPermissionedRegistry releases = releaseRegistry(label);
        releases.register(LibString.toString(version), address(this), address(0), deployment, 0, type(uint64).max);
        releases.setResolver(uint256(keccak256(bytes(PREVIEW_LABEL))), deployment);
    }

    /// The project's own registry, holding its release names. Set at claim and locked.
    function releaseRegistry(string calldata label) public view returns (IPermissionedRegistry registry) {
        registry = IPermissionedRegistry(REGISTRY.getSubregistry(label));
        if (address(registry) == address(0)) revert NoReleaseRegistry(label);
    }

    /// Release and preview name tokens are minted to this contract, which never moves them.
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return this.onERC1155BatchReceived.selector;
    }

    /// Tightly packs addresses (abi.encodePacked pads array elements to 32 bytes).
    function _pack(address[] memory pointers) internal pure returns (bytes memory out) {
        out = new bytes(pointers.length * 20);
        for (uint256 i; i < pointers.length; ++i) {
            address p = pointers[i];
            assembly ("memory-safe") {
                mstore(add(add(out, 0x20), mul(i, 20)), shl(96, p))
            }
        }
    }

    function _checkPublisher(string calldata label, address account) internal view {
        if (REGISTRY.getOwner(uint256(keccak256(bytes(label)))) == address(0)) revert ProjectNotClaimed(label);
        if (!canPublish(label, account)) revert NotPublisher(label, account);
    }

    function _salt(bytes32 node, uint64 version) internal pure returns (bytes32) {
        return keccak256(abi.encode(node, version));
    }
}
