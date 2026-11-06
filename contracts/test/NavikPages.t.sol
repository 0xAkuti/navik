// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Base64} from "solady/utils/Base64.sol";

import {ENSv2Mainnet} from "../script/ENSv2Mainnet.sol";
import {Deployment} from "../src/Deployment.sol";
import {ENSv2Roles, IPermissionedResolver} from "../src/interfaces/IENSv2.sol";
import {NavikHooks} from "../src/libraries/NavikHooks.sol";
import {NavikNames} from "../src/libraries/NavikNames.sol";
import {NavikPages} from "../src/NavikPages.sol";
import {NavikForkBase} from "./NavikFork.t.sol";

/// What eth.limo does for `<name>.limo`: read `contenthash` through ENS, then call the hook.
contract NavikPagesTest is NavikForkBase {
    string internal constant PREFIX = "data:text/html;base64,";

    function _contenthash(string memory fqdn) internal view returns (bytes memory) {
        bytes memory dns = NavikNames.dnsEncode(fqdn);
        (bytes memory result,) =
            ur.resolve(dns, abi.encodeCall(IPermissionedResolver.contenthash, (NavikNames.namehash(dns, 0))));
        return abi.decode(result, (bytes));
    }

    function _pageRecord(string memory fqdn) internal view returns (bytes memory) {
        return NavikHooks.contenthash("page(string)", string.concat("page('", fqdn, "')"), address(n.pages));
    }

    function _document(bytes memory dataUrl) internal pure returns (bytes memory) {
        bytes memory prefix = bytes(PREFIX);
        assertEq(_slice(dataUrl, 0, prefix.length), PREFIX);
        return Base64.decode(_slice(dataUrl, prefix.length, dataUrl.length));
    }

    function test_hook_encoding() public {
        address target = 0x1234567890123456789012345678901234567890;
        bytes memory expected = bytes.concat(
            hex"30009b6113bfa3",
            abi.encode("page()", "page()", "(bytes)", hex"000100000101141234567890123456789012345678901234567890")
        );
        assertEq(NavikHooks.contenthash("page()", "page()", target), expected);
        vm.chainId(31337);
        assertEq(NavikHooks.erc7930(target), hex"00010000027a69141234567890123456789012345678901234567890");
    }

    function test_project_servedThroughItsContenthash() public {
        _claim("portfolio", alice);
        assertEq(_contenthash("portfolio.navik.eth"), _pageRecord("portfolio.navik.eth"));

        vm.expectRevert(abi.encodeWithSelector(NavikPages.NoSite.selector, "portfolio.navik.eth"));
        n.pages.page("portfolio.navik.eth");

        (address v1,) = _publish(alice, "portfolio", "<h1>one</h1>");
        (address v2,) = _publish(alice, "portfolio", unicode"<h1>två</h1>");
        _promote(alice, "portfolio", v1);
        assertEq(_document(n.pages.page("portfolio.navik.eth")), "<h1>one</h1>");
        _promote(alice, "portfolio", v2);
        assertEq(_document(n.pages.page("portfolio.navik.eth")), bytes(unicode"<h1>två</h1>"));
        assertEq(_contenthash("portfolio.navik.eth"), _pageRecord("portfolio.navik.eth")); // nothing to update
    }

    function test_root_servesRootProject() public {
        (address d,) = _publish(rootOwner, ROOT_PROJECT, "<h1>dashboard</h1>");
        _promote(rootOwner, ROOT_PROJECT, d);
        assertEq(_contenthash("navik.eth"), _pageRecord("app.navik.eth"));
        assertEq(_document(n.pages.page("navik.eth")), "<h1>dashboard</h1>");
    }

    function test_releases_servedByThemselves() public {
        _claim("portfolio", alice);
        (address v1,) = _publish(alice, "portfolio", "<h1>one</h1>");
        (address v2,) = _publish(alice, "portfolio", "<h1>two</h1>");

        assertEq(_contenthash("1.portfolio.navik.eth"), NavikHooks.contenthash("page()", "page()", v1));
        assertEq(_contenthash("preview.portfolio.navik.eth"), NavikHooks.contenthash("page()", "page()", v2));
        assertEq(_document(Deployment(v1).page()), "<h1>one</h1>");
        assertEq(_document(Deployment(v2).page()), "<h1>two</h1>");
        assertEq(_document(n.pages.page("1.portfolio.navik.eth")), "<h1>one</h1>");
    }

    function test_contentcontract_formats() public {
        IPermissionedResolver r = _claim("portfolio", alice);
        (address d,) = _publish(alice, "portfolio", "<h1>one</h1>");
        vm.startPrank(alice);
        r.setText(_dns("portfolio"), "contentcontract", string.concat("eth:", _hex(d)));
        assertEq(n.pages.site("portfolio.navik.eth"), d);

        string[3] memory invalid = [string.concat("base:", _hex(d)), "not an address", "0xzz"];
        for (uint256 i; i < invalid.length; ++i) {
            r.setText(_dns("portfolio"), "contentcontract", invalid[i]);
            vm.expectRevert(abi.encodeWithSelector(NavikPages.NoSite.selector, "portfolio.navik.eth"));
            n.pages.site("portfolio.navik.eth");
        }
        vm.stopPrank();
    }

    function test_owner_canReplaceTheContenthash() public {
        IPermissionedResolver r = _claim("portfolio", alice);
        vm.prank(alice);
        r.setContenthash(_dns("portfolio"), hex"e301");
        assertEq(_contenthash("portfolio.navik.eth"), hex"e301");
    }

    function _pageGas(uint256 size) internal returns (uint256 used, uint256 length) {
        string memory label = string.concat("size", vm.toString(size));
        _claim(label, alice);
        bytes[] memory chunks = _chunks(_content(size, size));
        address[] memory pointers = new address[](chunks.length);
        for (uint256 i; i < chunks.length; ++i) {
            bytes[] memory one = new bytes[](1);
            one[0] = chunks[i];
            pointers[i] = n.factory.storeChunks(one)[0];
        }
        vm.prank(alice);
        (address d,) = n.factory.publish(label, pointers);
        _promote(alice, label, d);

        string memory name = string.concat(label, ".navik.eth");
        uint256 before = gasleft();
        bytes memory url = n.pages.page(name);
        used = before - gasleft();
        length = url.length;
    }

    /// eth.limo stops at a 1,000,000 byte data URL. Below that, the limit is the RPC's `eth_call`
    /// gas cap (50M by default in geth); sdk/src/limo.ts warns from the size checked here.
    function test_page_gas() public {
        uint256[3] memory sizes = [uint256(200_000), 450_000, 749_970];
        for (uint256 i; i < sizes.length; ++i) {
            (uint256 used, uint256 length) = _pageGas(sizes[i]);
            emit log_named_uint(string.concat("page() gas, ", vm.toString(sizes[i]), " B"), used);
            assertLe(length, 1_000_000);
            if (sizes[i] <= 450_000) assertLt(used, 50_000_000);
        }
    }
}
