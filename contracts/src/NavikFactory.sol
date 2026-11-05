// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {CREATE3} from "solady/utils/CREATE3.sol";
import {LibClone} from "solady/utils/LibClone.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";

import {Deployment} from "./Deployment.sol";
import {ENSv2Roles, IPermissionedRegistry, IPermissionedResolver} from "./interfaces/IENSv2.sol";
import {NavikNames} from "./libraries/NavikNames.sol";

/// Publishes immutable releases for projects under navik.eth.
///
/// No owner, no upgrades. Versions are append-only: version N of a project lives at
/// CREATE3(this, keccak(projectNode, N)) and a CREATE3 salt can never be reused.
///
/// Who may publish is decided by ENSv2, not by this contract:
/// - the owner of `<project>.navik.eth` in the Navik registry, or
/// - an account the project's Permissioned Resolver allows to set the `navik.publish` text key
///   (root holders pass automatically; others get it via `grantSetterRoles`).
contract NavikFactory {
    error ProjectNotClaimed(string label);
    error NotPublisher(string label, address account);
    error InvalidContent();

    event DeploymentPublished(
        bytes32 indexed projectNode,
        uint64 indexed version,
        address indexed deployment,
        string label,
        bytes32 contentHash,
        address pointer,
        address publisher
    );

    /// EAC resource for the publish capability: keccak256("navik.publish").
    string public constant PUBLISH_KEY = "navik.publish";
    uint256 public constant PUBLISH_RESOURCE = uint256(keccak256(bytes(PUBLISH_KEY)));
    /// SSTORE2 data contracts are capped by EIP-170 (24,576 bytes minus the STOP prefix).
    uint256 public constant MAX_SIZE = 24_575;

    IPermissionedRegistry public immutable REGISTRY;
    bytes32 public immutable ROOT_NODE;
    address public immutable IMPLEMENTATION;

    mapping(bytes32 projectNode => uint64) public versionCount;

    constructor(IPermissionedRegistry registry, bytes32 rootNode) {
        REGISTRY = registry;
        ROOT_NODE = rootNode;
        IMPLEMENTATION = address(new Deployment());
    }

    function publish(string calldata label, bytes calldata html) external returns (address deployment, uint64 version) {
        if (html.length == 0 || html.length > MAX_SIZE) revert InvalidContent();
        _checkPublisher(label, msg.sender);

        // content is shared across projects and versions: identical bytes are stored once
        address pointer = SSTORE2.predictCounterfactualAddress(html, bytes32(0));
        if (pointer.code.length == 0) SSTORE2.writeCounterfactual(html, bytes32(0));

        bytes32 node = projectNode(label);
        version = ++versionCount[node];
        bytes32 contentHash = keccak256(html);
        bytes memory args = abi.encodePacked(node, version, contentHash, pointer, uint32(html.length));
        deployment = CREATE3.deployDeterministic(LibClone.initCode(IMPLEMENTATION, args), _salt(node, version));

        emit DeploymentPublished(node, version, deployment, label, contentHash, pointer, msg.sender);
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
        try Deployment(deployment).manifest() returns (bytes32 node, uint64 version, bytes32, address, uint32) {
            return deployment == deploymentOf(node, version);
        } catch {
            return false;
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
