// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {LibClone} from "solady/utils/LibClone.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";

import {NavikChunks} from "./libraries/NavikChunks.sol";

/// ERC-8244 contract-hosted app: one immutable release of a Navik project.
///
/// Deployed by NavikFactory as a clone with immutable args, so it has no storage,
/// no initializer and no owner. Args layout (packed):
///   bytes32 projectNode | uint64 version | bytes32 contentHash | uint32 size | uint16 chunkCount
///   | address[chunkCount] pointers
/// The document is the concatenation of the chunks behind `pointers`.
contract Deployment {
    uint256 internal constant POINTERS_OFFSET = 78;

    address public immutable factory;

    constructor() {
        factory = msg.sender;
    }

    /// ERC-8244: the full HTML document.
    function html() external view returns (string memory) {
        return string(NavikChunks.read(pointers()));
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
}
