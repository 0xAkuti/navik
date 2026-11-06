// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Base64} from "solady/utils/Base64.sol";

/// ERC-8121 hook, as an ENS `contenthash`: the record names a function to `eth_call` for the site.
interface IHook {
    function hook(
        string calldata functionSignature,
        string calldata functionCall,
        string calldata returnType,
        bytes calldata target
    ) external;
}

/// `contenthash` records and data URLs for gateways that serve fully onchain sites (eth.limo).
library NavikHooks {
    /// Placeholder codec of ERC-8121 hooks in contenthash records, as eth.limo reads them.
    bytes3 internal constant PROTOCODE = 0x30009b;

    /// A hook calling `functionCall` (arguments are literals: gateways pass none) on `target`.
    function contenthash(string memory functionSignature, string memory functionCall, address target)
        internal
        view
        returns (bytes memory)
    {
        return abi.encodePacked(
            PROTOCODE, abi.encodeCall(IHook.hook, (functionSignature, functionCall, "(bytes)", erc7930(target)))
        );
    }

    /// ERC-7930 address of `target` on this chain: version 1, EIP-155, chain id without leading zeros.
    function erc7930(address target) internal view returns (bytes memory) {
        uint256 id = block.chainid;
        uint256 length;
        for (uint256 v = id; v != 0; v >>= 8) ++length;
        bytes memory reference_ = new bytes(length);
        for (uint256 i = length; i != 0; id >>= 8) reference_[--i] = bytes1(uint8(id));
        return abi.encodePacked(hex"00010000", uint8(length), reference_, uint8(20), target);
    }

    /// Exactly this form: eth.limo's parser takes no other parameter (a charset makes it fail).
    function dataUrl(bytes memory html) internal pure returns (bytes memory) {
        return abi.encodePacked("data:text/html;base64,", Base64.encode(html));
    }
}
