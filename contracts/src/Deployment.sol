// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {LibClone} from "solady/utils/LibClone.sol";
import {LibString} from "solady/utils/LibString.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";

import {IExtendedResolver} from "./interfaces/IENSv2.sol";
import {NavikChunks} from "./libraries/NavikChunks.sol";
import {NavikHooks} from "./libraries/NavikHooks.sol";

/// ERC-8244 contract-hosted app: one immutable release of a Navik project.
///
/// Deployed by NavikFactory as a clone with immutable args, so it has no storage,
/// no initializer and no owner. Args layout (packed):
///   bytes32 projectNode | uint64 version | bytes32 contentHash | uint32 size | uint16 chunkCount
///   | address[chunkCount] pointers
/// The document is the concatenation of the chunks behind `pointers`.
///
/// Each release is also the ENS resolver of its own name (`<N>.<project>.navik.eth`): it answers
/// `contentcontract` and `addr` with its own address, whatever name it is reached through (for
/// example `<N>.alice.eth` when alice.eth shares the project's registry), and `contenthash` with
/// a hook on its own `page()`, so gateways like eth.limo can serve it.
contract Deployment is IExtendedResolver {
    error UnsupportedResolverProfile(bytes4 selector);

    uint256 internal constant POINTERS_OFFSET = 78;
    bytes4 private constant ADDR = 0x3b3b57de; // addr(bytes32)
    bytes4 private constant ADDR_COIN = 0xf1cb7e06; // addr(bytes32,uint256)
    bytes4 private constant TEXT = 0x59d1d43c; // text(bytes32,string)
    bytes4 private constant CONTENTHASH = 0xbc1c58d1; // contenthash(bytes32)
    bytes4 private constant MULTICALL = 0xac9650d8; // multicall(bytes[])
    uint256 private constant COIN_TYPE_ETH = 60;

    address public immutable factory;

    constructor() {
        factory = msg.sender;
    }

    /// ERC-8244: the full HTML document.
    function html() external view returns (string memory) {
        return string(NavikChunks.read(pointers()));
    }

    /// The document as a data URL, for gateways that follow `contenthash` hooks (ERC-8121).
    function page() external view returns (bytes memory) {
        return NavikHooks.dataUrl(NavikChunks.read(pointers()));
    }

    /// Number of chunks; with `chunk(i)`, lets clients page through large documents when an
    /// RPC limits `eth_call` response size.
    function chunkCount() public view returns (uint256) {
        return uint16(bytes2(LibClone.argsOnClone(address(this), 76, 78)));
    }

    function chunk(uint256 i) external view returns (bytes memory) {
        return SSTORE2.read(pointers()[i]);
    }

    function pointers() public view returns (address[] memory ps) {
        bytes memory a = LibClone.argsOnClone(address(this), POINTERS_OFFSET);
        uint256 n = a.length / 20;
        ps = new address[](n);
        for (uint256 i; i < n; ++i) {
            address p;
            assembly ("memory-safe") {
                p := shr(96, mload(add(add(a, 0x20), mul(i, 20))))
            }
            ps[i] = p;
        }
    }

    function manifest()
        external
        view
        returns (bytes32 projectNode_, uint64 version_, bytes32 contentHash_, uint32 size_, address[] memory pointers_)
    {
        return (projectNode(), version(), contentHash(), size(), pointers());
    }

    function projectNode() public view returns (bytes32) {
        return bytes32(LibClone.argsOnClone(address(this), 0, 32));
    }

    function version() public view returns (uint64) {
        return uint64(bytes8(LibClone.argsOnClone(address(this), 32, 40)));
    }

    function contentHash() public view returns (bytes32) {
        return bytes32(LibClone.argsOnClone(address(this), 40, 72));
    }

    function size() public view returns (uint32) {
        return uint32(bytes4(LibClone.argsOnClone(address(this), 72, 76)));
    }

    // ------------------------------------------------------------------ ENS resolver

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IExtendedResolver).interfaceId || interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == ADDR || interfaceId == ADDR_COIN || interfaceId == TEXT || interfaceId == CONTENTHASH;
    }

    /// ENSIP-10: answers any name served by this resolver.
    function resolve(bytes calldata, bytes calldata data) external view returns (bytes memory) {
        bytes4 selector = bytes4(data);
        if (selector == MULTICALL) {
            bytes[] memory calls = abi.decode(data[4:], (bytes[]));
            for (uint256 i; i < calls.length; ++i) {
                (, bytes memory v) = address(this).staticcall(calls[i]); // result or revert data, as ENS resolvers do
                calls[i] = v;
            }
            return abi.encode(calls);
        }
        if (selector == ADDR || selector == ADDR_COIN || selector == TEXT || selector == CONTENTHASH) {
            (bool ok, bytes memory v) = address(this).staticcall(data);
            if (!ok) revert UnsupportedResolverProfile(selector);
            return v;
        }
        revert UnsupportedResolverProfile(selector);
    }

    function addr(bytes32) external view returns (address) {
        return address(this);
    }

    function addr(bytes32, uint256 coinType) external view returns (bytes memory) {
        return coinType == COIN_TYPE_ETH ? abi.encodePacked(address(this)) : bytes("");
    }

    function contenthash(bytes32) external view returns (bytes memory) {
        return NavikHooks.contenthash("page()", "page()", address(this));
    }

    /// `contentcontract` (ERC-8244), plus `navik.version` and `navik.contenthash`.
    function text(bytes32, string calldata key) external view returns (string memory) {
        bytes32 k = keccak256(bytes(key));
        if (k == keccak256("contentcontract")) return LibString.toHexStringChecksummed(address(this));
        if (k == keccak256("navik.version")) return LibString.toString(version());
        if (k == keccak256("navik.contenthash")) return LibString.toHexString(uint256(contentHash()), 32);
        return "";
    }
}
