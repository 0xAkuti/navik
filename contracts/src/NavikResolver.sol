// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IExtendedResolver, IPermissionedRegistry} from "./interfaces/IENSv2.sol";
import {NavikNames} from "./libraries/NavikNames.sol";

/// Resolver of navik.eth.
///
/// navik.eth itself is an alias of the root project (e.g. `app.navik.eth`): every query for the
/// root name is forwarded to that project's resolver, so navik.eth serves its production and
/// follows its promotions and rollbacks like any other project. Names under navik.eth that are
/// not registered fall back here (ENSIP-10) and do not resolve. No owner, no upgrades.
contract NavikResolver is IExtendedResolver {
    error UnknownName(bytes name);

    bytes4 private constant MULTICALL = 0xac9650d8; // multicall(bytes[])

    IPermissionedRegistry public immutable REGISTRY;
    bytes32 public immutable ROOT_NODE;
    /// Project whose records navik.eth serves. Set once, no setter.
    string public rootProject;

    constructor(IPermissionedRegistry registry, bytes32 rootNode, string memory rootProject_) {
        REGISTRY = registry;
        ROOT_NODE = rootNode;
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
        if (NavikNames.namehash(name, 0) != ROOT_NODE) revert UnknownName(name);
        string memory project = rootProject;
        address resolver = REGISTRY.getResolver(project);
        if (resolver == address(0)) revert UnknownName(name);
        return IExtendedResolver(resolver).resolve(NavikNames.dnsEncode(project, name), data);
    }
}
