// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {LibClone} from "solady/utils/LibClone.sol";
import {SSTORE2} from "solady/utils/SSTORE2.sol";

/// ERC-8244 contract-hosted app: one immutable release of a Navik project.
///
/// Deployed by NavikFactory as a clone with immutable args, so it has no storage,
/// no initializer and no owner. Args layout (packed, 96 bytes):
///   bytes32 projectNode | uint64 version | bytes32 contentHash | address pointer | uint32 size
contract Deployment {
    address public immutable factory;

    constructor() {
        factory = msg.sender;
    }

    /// ERC-8244: the full HTML document.
    function html() external view returns (string memory) {
        return string(SSTORE2.read(pointer()));
    }

    function manifest()
        external
        view
        returns (bytes32 projectNode_, uint64 version_, bytes32 contentHash_, address pointer_, uint32 size_)
    {
        return (projectNode(), version(), contentHash(), pointer(), size());
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

    function pointer() public view returns (address) {
        return address(bytes20(LibClone.argsOnClone(address(this), 72, 92)));
    }

    function size() public view returns (uint32) {
        return uint32(bytes4(LibClone.argsOnClone(address(this), 92, 96)));
    }
}
