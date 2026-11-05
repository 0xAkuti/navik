// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// Label rules and DNS-name helpers shared by the registrar and resolver.
///
/// Project labels: 3-63 chars of [a-z0-9-], no leading, trailing or double hyphen.
library NavikNames {
    error InvalidName();

    uint256 internal constant MIN_LABEL = 3;
    uint256 internal constant MAX_LABEL = 63;

    function node(bytes32 parent, string memory label) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(parent, keccak256(bytes(label))));
    }

    function isValidProjectLabel(string memory label) internal pure returns (bool) {
        bytes memory b = bytes(label);
        uint256 n = b.length;
        if (n < MIN_LABEL || n > MAX_LABEL) return false;
        if (b[0] == "-" || b[n - 1] == "-") return false;
        for (uint256 i; i < n; ++i) {
            bytes1 c = b[i];
            bool ok = (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c == "-";
            if (!ok) return false;
            if (c == "-" && b[i + 1] == "-") return false; // safe: last char is not "-"
        }
        return true;
    }

    /// Reads the DNS-encoded label at `offset`. Returns the label and the next offset.
    function readLabel(bytes memory name, uint256 offset) internal pure returns (bytes memory label, uint256 next) {
        if (offset >= name.length) revert InvalidName();
        uint256 len = uint8(name[offset]);
        next = offset + 1 + len;
        if (next > name.length) revert InvalidName();
        label = new bytes(len);
        for (uint256 i; i < len; ++i) {
            label[i] = name[offset + 1 + i];
        }
    }

    /// ENS namehash of the DNS-encoded `name` starting at `offset`.
    function namehash(bytes memory name, uint256 offset) internal pure returns (bytes32) {
        (bytes memory label, uint256 next) = readLabel(name, offset);
        if (label.length == 0) {
            if (next != name.length) revert InvalidName(); // root must be the last byte
            return bytes32(0);
        }
        return keccak256(abi.encodePacked(namehash(name, next), keccak256(label)));
    }

    /// DNS-encodes a single label followed by an already DNS-encoded parent.
    function dnsEncode(string memory label, bytes memory parentDns) internal pure returns (bytes memory) {
        bytes memory b = bytes(label);
        if (b.length == 0 || b.length > 255) revert InvalidName();
        return abi.encodePacked(uint8(b.length), b, parentDns);
    }
}
