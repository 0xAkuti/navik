// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";

import {NavikNames} from "../src/libraries/NavikNames.sol";

contract NavikNamesTest is Test {
    function test_validProjectLabels() public pure {
        assertTrue(NavikNames.isValidProjectLabel("portfolio"));
        assertTrue(NavikNames.isValidProjectLabel("my-site"));
        assertTrue(NavikNames.isValidProjectLabel("abc"));
        assertTrue(NavikNames.isValidProjectLabel("v2site"));
        assertTrue(NavikNames.isValidProjectLabel("site-v"));
        assertTrue(NavikNames.isValidProjectLabel("site-vx1"));
        assertTrue(NavikNames.isValidProjectLabel("site-v01")); // not a canonical version label
    }

    function test_invalidProjectLabels() public pure {
        assertFalse(NavikNames.isValidProjectLabel("ab"));
        assertFalse(NavikNames.isValidProjectLabel("-abc"));
        assertFalse(NavikNames.isValidProjectLabel("abc-"));
        assertFalse(NavikNames.isValidProjectLabel("a--b"));
        assertFalse(NavikNames.isValidProjectLabel("Upper"));
        assertFalse(NavikNames.isValidProjectLabel("dot.ted"));
        assertFalse(NavikNames.isValidProjectLabel("site-v1")); // reserved for releases
        assertFalse(NavikNames.isValidProjectLabel("my-site-v42"));
        assertFalse(NavikNames.isValidProjectLabel(string(new bytes(64))));
    }

    function test_parseVersionLabel() public pure {
        (bool ok, string memory project, uint64 version) = NavikNames.parseVersionLabel("portfolio-v3");
        assertTrue(ok);
        assertEq(project, "portfolio");
        assertEq(version, 3);

        (ok, project, version) = NavikNames.parseVersionLabel("my-site-v120");
        assertTrue(ok);
        assertEq(project, "my-site");
        assertEq(version, 120);
    }

    function test_parseVersionLabel_rejects() public pure {
        bool ok;
        (ok,,) = NavikNames.parseVersionLabel("portfolio");
        assertFalse(ok);
        (ok,,) = NavikNames.parseVersionLabel("portfolio-v0");
        assertFalse(ok);
        (ok,,) = NavikNames.parseVersionLabel("portfolio-v01");
        assertFalse(ok);
        (ok,,) = NavikNames.parseVersionLabel("portfolio-v");
        assertFalse(ok);
        (ok,,) = NavikNames.parseVersionLabel("portfolio-V1");
        assertFalse(ok);
        (ok,,) = NavikNames.parseVersionLabel("-v1");
        assertFalse(ok);
        (ok,,) = NavikNames.parseVersionLabel("portfolio-v1x");
        assertFalse(ok);
        (ok,,) = NavikNames.parseVersionLabel("portfolio-v99999999999999999999");
        assertFalse(ok);
    }

    function test_namehash() public pure {
        bytes memory dns = hex"056e6176696b0365746800"; // navik.eth
        bytes32 eth = keccak256(abi.encodePacked(bytes32(0), keccak256("eth")));
        assertEq(NavikNames.namehash(dns, 0), keccak256(abi.encodePacked(eth, keccak256("navik"))));
        assertEq(NavikNames.namehash(dns, 6), eth);
        assertEq(NavikNames.dnsEncode("navik", hex"0365746800"), dns);
    }

    function test_namehash_rejectsTrailingBytes() public {
        vm.expectRevert(NavikNames.InvalidName.selector);
        this.namehash(hex"0365746800ff");
    }

    function namehash(bytes memory name) external pure returns (bytes32) {
        return NavikNames.namehash(name, 0);
    }
}
