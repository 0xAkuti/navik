// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {LibString} from "solady/utils/LibString.sol";

import {Deployment} from "./Deployment.sol";
import {IExtendedResolver, IPermissionedRegistry} from "./interfaces/IENSv2.sol";
import {NavikNames} from "./libraries/NavikNames.sol";
import {NavikFactory} from "./NavikFactory.sol";

/// Resolver of navik.eth: serves the permanent release names `<project>-v<N>.navik.eth`.
///
/// ENSv2 walks registries from the root; labels that are not registered in the Navik
/// registry fall back to navik.eth's resolver (ENSIP-10 wildcard). Answers are computed
/// from the factory, so release names need no writes, cannot be changed by anyone, and
/// unknown versions never resolve. No owner, no upgrades.
///
/// navik.eth itself is an alias of the root project (e.g. `app.navik.eth`): every query for the
/// root name is forwarded to that project's resolver, so navik.eth serves its production and
/// follows its promotions and rollbacks like any other project.
contract NavikResolver is IExtendedResolver {
    error UnknownName(bytes name);
    error UnsupportedResolverProfile(bytes4 selector);

    bytes4 private constant ADDR = 0x3b3b57de; // addr(bytes32)
    bytes4 private constant ADDR_COIN = 0xf1cb7e06; // addr(bytes32,uint256)
    bytes4 private constant TEXT = 0x59d1d43c; // text(bytes32,string)
    bytes4 private constant MULTICALL = 0xac9650d8; // multicall(bytes[])
    uint256 private constant COIN_TYPE_ETH = 60;

    NavikFactory public immutable FACTORY;
    IPermissionedRegistry public immutable REGISTRY;
    bytes32 public immutable ROOT_NODE;
    /// Project whose records navik.eth serves. Set once, no setter.
    string public rootProject;

    constructor(NavikFactory factory, string memory rootProject_) {
        FACTORY = factory;
        REGISTRY = factory.REGISTRY();
        ROOT_NODE = factory.ROOT_NODE();
        rootProject = rootProject_;
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IExtendedResolver).interfaceId || interfaceId == 0x01ffc9a7; // ERC-165
    }

    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory) {
        if (bytes4(data) == MULTICALL) {
            bytes[] memory calls = abi.decode(data[4:], (bytes[]));
            for (uint256 i; i < calls.length; ++i) {
                try this.resolve(name, calls[i]) returns (bytes memory v) {
                    calls[i] = v;
                } catch (bytes memory err) {
                    calls[i] = err;
                }
            }
            return abi.encode(calls);
        }
        if (NavikNames.namehash(name, 0) == ROOT_NODE) return _forwardRoot(name, data);
        (string memory project, uint64 version, address deployment) = release(name);
        return _answer(data, project, version, deployment);
    }

    /// Decodes `<project>-v<N>.navik.eth` (DNS-encoded) to an existing release, or reverts.
    function release(bytes memory name)
        public
        view
        returns (string memory project, uint64 version, address deployment)
    {
        (bytes memory label, uint256 next) = NavikNames.readLabel(name, 0);
        if (NavikNames.namehash(name, next) != ROOT_NODE) revert UnknownName(name);
        bool ok;
        (ok, project, version) = NavikNames.parseVersionLabel(label);
        if (!ok) revert UnknownName(name);
        deployment = FACTORY.deploymentOf(NavikNames.node(ROOT_NODE, project), version);
        if (deployment == address(0)) revert UnknownName(name);
    }

    /// Answers for navik.eth from the root project's own resolver (any record, any profile).
    function _forwardRoot(bytes calldata name, bytes calldata data) internal view returns (bytes memory) {
        string memory project = rootProject;
        address resolver = REGISTRY.getResolver(project);
        if (resolver == address(0)) revert UnknownName(name);
        return IExtendedResolver(resolver).resolve(NavikNames.dnsEncode(project, name), data);
    }

    function _answer(bytes calldata data, string memory project, uint64 version, address deployment)
        internal
        view
        returns (bytes memory)
    {
        bytes4 selector = bytes4(data);
        if (selector == ADDR) return abi.encode(deployment);
        if (selector == ADDR_COIN) {
            (, uint256 coinType) = abi.decode(data[4:], (bytes32, uint256));
            return abi.encode(coinType == COIN_TYPE_ETH ? abi.encodePacked(deployment) : bytes(""));
        }
        if (selector == TEXT) {
            (, string memory key) = abi.decode(data[4:], (bytes32, string));
            return abi.encode(_text(key, project, version, deployment));
        }
        revert UnsupportedResolverProfile(selector);
    }

    function _text(string memory key, string memory project, uint64 version, address deployment)
        internal
        view
        returns (string memory)
    {
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("contentcontract")) return LibString.toHexStringChecksummed(deployment);
        if (k == keccak256("navik.project")) return project;
        if (k == keccak256("navik.version")) return LibString.toString(version);
        if (k == keccak256("navik.contenthash")) {
            return LibString.toHexString(uint256(Deployment(deployment).contentHash()), 32);
        }
        return "";
    }
}
