// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {IPermissionedResolver} from "./interfaces/IENSv2.sol";
import {NavikHooks} from "./libraries/NavikHooks.sol";
import {NavikNames} from "./libraries/NavikNames.sol";

interface IERC8244 {
    function html() external view returns (string memory);
}

interface IUniversalResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory, address);
}

/// Serves any ERC-8244 name as a data URL, for gateways that follow `contenthash` hooks (ERC-8121).
///
/// A project's `contenthash` calls `page("<project>.navik.eth")`, so the record never changes:
/// each read follows the name's current `contentcontract`, and promotions and rollbacks apply.
/// Stateless: no owner, no upgrades, and it knows nothing about Navik.
contract NavikPages {
    error NoSite(string name);

    IUniversalResolver public immutable UNIVERSAL_RESOLVER;

    constructor(IUniversalResolver universalResolver) {
        UNIVERSAL_RESOLVER = universalResolver;
    }

    function page(string calldata name) external view returns (bytes memory) {
        return NavikHooks.dataUrl(bytes(IERC8244(site(name)).html()));
    }

    /// The contract `name` points at through ENS.
    function site(string calldata name) public view returns (address) {
        bytes memory dns = NavikNames.dnsEncode(name);
        bytes memory data =
            abi.encodeCall(IPermissionedResolver.text, (NavikNames.namehash(dns, 0), "contentcontract"));
        try UNIVERSAL_RESOLVER.resolve(dns, data) returns (bytes memory result, address) {
            (bool ok, address target) = _parse(bytes(abi.decode(result, (string))));
            if (ok) return target;
        } catch {}
        revert NoSite(name);
    }

    /// `contentcontract` values on this chain: `0x…`, or `eth:0x…` (ERC-3770).
    function _parse(bytes memory value) internal pure returns (bool ok, address target) {
        uint256 start = value.length == 46 && bytes4(value) == "eth:" ? 4 : 0;
        if (value.length != start + 42 || value[start] != "0" || value[start + 1] != "x") return (false, target);
        uint160 a;
        for (uint256 i = start + 2; i < value.length; ++i) {
            uint8 c = uint8(value[i]);
            uint8 digit;
            if (c >= 0x30 && c <= 0x39) digit = c - 0x30;
            else if (c >= 0x41 && c <= 0x46) digit = c - 0x37;
            else if (c >= 0x61 && c <= 0x66) digit = c - 0x57;
            else return (false, target);
            a = (a << 4) | digit;
        }
        return (true, address(a));
    }
}
