// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import {Test} from "forge-std/Test.sol";
import {LibString} from "solady/utils/LibString.sol";

import {ENSv2Mainnet} from "../script/ENSv2Mainnet.sol";
import {Navik, NavikDeploy} from "../script/NavikDeploy.sol";
import {Deployment} from "../src/Deployment.sol";
import {ENSv2Roles, IPermissionedRegistry, IPermissionedResolver} from "../src/interfaces/IENSv2.sol";
import {NavikChunks} from "../src/libraries/NavikChunks.sol";
import {NavikNames} from "../src/libraries/NavikNames.sol";
import {NavikFactory} from "../src/NavikFactory.sol";
import {NavikRegistrar} from "../src/NavikRegistrar.sol";
import {NavikResolver} from "../src/NavikResolver.sol";

interface IUniversalResolver {
    function resolve(bytes calldata name, bytes calldata data) external view returns (bytes memory, address);
}

interface ITextResolver {
    function text(bytes32 node, string calldata key) external view returns (string memory);
}

interface IAddrResolver {
    function addr(bytes32 node) external view returns (address);
}

/// Runs against real ENSv2 on a mainnet fork. navik.eth is registered on the fork by
/// impersonating ETHRegistrar, exactly with the roles a real purchase grants. Like a fresh
/// deployment, navik.eth starts attached but not frozen.
abstract contract NavikForkBase is Test {
    uint256 internal constant FORK_BLOCK = 26_349_600;
    string internal constant ROOT = "navik";
    bytes internal constant ROOT_DNS = hex"056e6176696b0365746800"; // navik.eth

    IPermissionedRegistry internal eth = IPermissionedRegistry(ENSv2Mainnet.ETH_REGISTRY);
    IUniversalResolver internal ur = IUniversalResolver(ENSv2Mainnet.UNIVERSAL_RESOLVER);

    Navik internal n;
    address internal rootOwner = makeAddr("navik.test.rootOwner"); // owns navik.eth (the Navik team)
    address internal deployer = makeAddr("navik.test.deployer"); // deploys the Navik contracts
    address internal alice = makeAddr("navik.test.alice"); // project creator
    address internal bob = makeAddr("navik.test.bob"); // another project creator
    address internal ci = makeAddr("navik.test.ci"); // alice's deploy key
    address internal mallory = makeAddr("navik.test.mallory");

    function setUp() public virtual {
        vm.createSelectFork(vm.envOr("MAINNET_RPC_URL", string("https://eth.drpc.org")), FORK_BLOCK);

        vm.prank(ENSv2Mainnet.ETH_REGISTRAR);
        eth.register(
            ROOT, rootOwner, address(0), address(0), ENSv2Mainnet.ETH_OWNER_ROLES, uint64(block.timestamp + 3650 days)
        );

        vm.prank(deployer);
        n = NavikDeploy.deploy(ROOT);

        vm.startPrank(rootOwner);
        NavikDeploy.attach(n, ROOT);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- helpers

    function _dns(string memory label) internal pure returns (bytes memory) {
        return NavikNames.dnsEncode(label, ROOT_DNS);
    }

    function _node(string memory label) internal view returns (bytes32) {
        return NavikNames.node(n.rootNode, label);
    }

    function _claim(string memory label, address owner) internal returns (IPermissionedResolver) {
        (address resolver,) = n.registrar.claim(label, owner);
        return IPermissionedResolver(resolver);
    }

    function _publish(address as_, string memory label, bytes memory html) internal returns (address d, uint64 v) {
        bytes[] memory chunks = _chunks(html);
        vm.prank(as_);
        (d, v) = n.factory.publishContent(label, chunks);
    }

    /// Splits `data` into CHUNK_SIZE pieces, like the CLI does.
    function _chunks(bytes memory data) internal pure returns (bytes[] memory chunks) {
        uint256 size = NavikChunks.CHUNK_SIZE;
        chunks = new bytes[]((data.length + size - 1) / size);
        for (uint256 i; i < chunks.length; ++i) {
            uint256 start = i * size;
            uint256 len = data.length - start < size ? data.length - start : size;
            bytes memory c = new bytes(len);
            for (uint256 j; j < len; ++j) {
                c[j] = data[start + j];
            }
            chunks[i] = c;
        }
    }

    /// Deterministic pseudo-random bytes (incompressible, never accidentally deduplicated).
    function _content(uint256 len, uint256 seed) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i; i < len; i += 32) {
            bytes32 w = keccak256(abi.encode(seed, i));
            assembly ("memory-safe") {
                mstore(add(add(out, 0x20), i), w)
            }
        }
        assembly ("memory-safe") {
            mstore(0x40, add(add(out, 0x20), and(add(len, 63), not(31)))) // cover the last word's overflow
        }
    }

    function _promote(address as_, string memory label, address deployment) internal {
        IPermissionedResolver r = IPermissionedResolver(n.registry.getResolver(label));
        vm.prank(as_);
        r.setText(_dns(label), "contentcontract", _hex(deployment));
    }

    function _promoteReverts(address as_, string memory label, address deployment) internal {
        IPermissionedResolver r = IPermissionedResolver(n.registry.getResolver(label));
        vm.expectRevert();
        vm.prank(as_);
        r.setText(_dns(label), "contentcontract", _hex(deployment));
    }

    /// Resolves like a wallet or browser would: through ENSv2's UniversalResolver.
    function _text(string memory label, string memory key) internal view returns (string memory) {
        bytes memory name = _dns(label);
        (bytes memory result,) =
            ur.resolve(name, abi.encodeCall(ITextResolver.text, (NavikNames.namehash(name, 0), key)));
        return abi.decode(result, (string));
    }

    function _addr(string memory label) internal view returns (address) {
        bytes memory name = _dns(label);
        (bytes memory result,) = ur.resolve(name, abi.encodeCall(IAddrResolver.addr, (NavikNames.namehash(name, 0))));
        return abi.decode(result, (address));
    }

    function _hex(address a) internal pure returns (string memory) {
        return LibString.toHexStringChecksummed(a);
    }

    function _grantPublish(address owner, string memory label, address account) internal {
        _grantText(owner, label, n.factory.PUBLISH_KEY(), account);
    }

    function _grantPromote(address owner, string memory label, address account) internal {
        _grantText(owner, label, "contentcontract", account);
    }

    /// Setter-scoped EAC grant: `account` may set text `key`, nothing else.
    function _grantText(address owner, string memory label, string memory key, address account) internal {
        IPermissionedResolver r = IPermissionedResolver(n.registry.getResolver(label));
        vm.prank(owner);
        r.grantSetterRoles(abi.encodeCall(IPermissionedResolver.setText, (_dns(label), key, "")), account);
    }
}

contract NavikForkTest is NavikForkBase {
    bytes internal constant SITE_V1 = "<!doctype html><title>portfolio</title><h1>v1</h1>";
    bytes internal constant SITE_V2 = "<!doctype html><title>portfolio</title><h1>v2</h1>";

    // ------------------------------------------------------------ content layer

    function test_publish_roundTrip() public {
        _claim("portfolio", alice);
        address predicted = n.factory.predict(_node("portfolio"), 1);
        (address d, uint64 v) = _publish(alice, "portfolio", SITE_V1);

        assertEq(v, 1);
        assertEq(d, predicted, "address is known before content exists");
        assertEq(Deployment(d).html(), string(SITE_V1));
        assertEq(Deployment(d).contentHash(), keccak256(SITE_V1));
        assertEq(Deployment(d).version(), 1);
        assertEq(Deployment(d).projectNode(), _node("portfolio"));
        assertEq(Deployment(d).factory(), address(n.factory));
        assertTrue(n.factory.isNavikDeployment(d));
    }

    /// Mainnet transaction gas cap (EIP-7825).
    uint256 internal constant TX_GAS_CAP = 1 << 24;

    /// Execution gas measured in-test plus intrinsic and calldata cost of sending it as a tx.
    function _txGas(uint256 execGas, uint256 calldataBytes) internal pure returns (uint256) {
        return 21_000 + 16 * calldataBytes + execGas;
    }

    function _storeInBatches(bytes[] memory chunks, uint256 perTx) internal returns (address[] memory pointers) {
        pointers = new address[](chunks.length);
        for (uint256 i; i < chunks.length; i += perTx) {
            uint256 m = chunks.length - i < perTx ? chunks.length - i : perTx;
            bytes[] memory batch = new bytes[](m);
            uint256 bytes_;
            for (uint256 j; j < m; ++j) {
                batch[j] = chunks[i + j];
                bytes_ += chunks[i + j].length;
            }
            uint256 g = gasleft();
            vm.prank(mallory); // storing is permissionless
            address[] memory ps = n.factory.storeChunks(batch);
            assertLt(_txGas(g - gasleft(), bytes_), TX_GAS_CAP, "store batch fits in one mainnet tx");
            for (uint256 j; j < m; ++j) {
                pointers[i + j] = ps[j];
            }
        }
    }

    function test_publishContent_twoFullChunksInOneTx() public {
        _claim("portfolio", alice);
        bytes memory site = _content(2 * NavikChunks.CHUNK_SIZE, 1);
        bytes[] memory chunks = _chunks(site);
        uint256 g = gasleft();
        vm.prank(alice);
        (address d,) = n.factory.publishContent("portfolio", chunks);
        uint256 used = _txGas(g - gasleft(), site.length);
        emit log_named_uint("tx gas: publishContent 2 full chunks (49,150 B)", used);
        assertLt(used, TX_GAS_CAP);
        assertEq(keccak256(bytes(Deployment(d).html())), keccak256(site));
    }

    function test_publish_multiChunk() public {
        _claim("portfolio", alice);
        bytes memory site = _content(3 * NavikChunks.CHUNK_SIZE + 10_000, 2); // 4 chunks, 83,725 B
        bytes[] memory chunks = _chunks(site);
        address[] memory pointers = _storeInBatches(chunks, 2);

        uint256 g = gasleft();
        vm.prank(alice);
        (address d, uint64 v) = n.factory.publish("portfolio", pointers);
        emit log_named_uint("tx gas: publish 4 stored chunks", _txGas(g - gasleft(), 20 * pointers.length));

        Deployment dep = Deployment(d);
        assertEq(v, 1);
        assertEq(keccak256(bytes(dep.html())), keccak256(site));
        assertEq(dep.contentHash(), keccak256(site));
        assertEq(dep.size(), site.length);
        assertEq(dep.chunkCount(), 4);
        for (uint256 i; i < chunks.length; ++i) {
            assertEq(dep.chunk(i), chunks[i]);
            assertEq(dep.pointers()[i], pointers[i]);
        }
        assertTrue(n.factory.isNavikDeployment(d));
        assertEq(_text("portfolio-v1", "contentcontract"), _hex(d));
        assertEq(_text("portfolio-v1", "navik.contenthash"), LibString.toHexString(uint256(keccak256(site)), 32));
    }

    function test_publish_largeSite() public {
        _claim("portfolio", alice);
        bytes memory site = _content(20 * NavikChunks.CHUNK_SIZE, 3); // 491,500 B
        address[] memory pointers = _storeInBatches(_chunks(site), 2);
        vm.prank(alice);
        (address d,) = n.factory.publish("portfolio", pointers);

        uint256 g = gasleft();
        bytes memory html = bytes(Deployment(d).html());
        emit log_named_uint("eth_call gas: html() of 491,500 B", g - gasleft());
        assertEq(keccak256(html), keccak256(site));
    }

    function test_publish_reusesUnchangedChunks() public {
        _claim("portfolio", alice);
        bytes memory v1 = _content(3 * NavikChunks.CHUNK_SIZE, 4);
        bytes[] memory c1 = _chunks(v1);
        (address d1,) = _publish(alice, "portfolio", v1);

        // v2 changes only the last chunk: the first two are already stored
        bytes[] memory c2 = _chunks(v1);
        c2[2] = _content(NavikChunks.CHUNK_SIZE, 5);
        uint256 g = gasleft();
        address[] memory p2 = n.factory.storeChunks(c2);
        emit log_named_uint("gas: store 3 chunks, 2 reused", g - gasleft());
        vm.prank(alice);
        (address d2,) = n.factory.publish("portfolio", p2);

        address[] memory p1 = Deployment(d1).pointers();
        assertEq(p1[0], p2[0]);
        assertEq(p1[1], p2[1]);
        assertTrue(p1[2] != p2[2]);
        assertEq(Deployment(d1).chunk(2), c1[2], "v1 is untouched");
        assertEq(Deployment(d2).chunk(2), c2[2]);
    }

    function test_publish_dedupesContent() public {
        _claim("portfolio", alice);
        (address d1,) = _publish(alice, "portfolio", SITE_V1);
        uint256 gasBefore = gasleft();
        (address d2,) = _publish(alice, "portfolio", SITE_V1);
        emit log_named_uint("gas: republish identical content", gasBefore - gasleft());
        assertTrue(d1 != d2, "every publish is a new release");
        assertEq(Deployment(d1).pointers()[0], Deployment(d2).pointers()[0], "bytes stored once");
    }

    function test_publish_rejectsInvalidContent() public {
        _claim("portfolio", alice);
        vm.startPrank(alice);

        vm.expectRevert(NavikFactory.InvalidContent.selector);
        n.factory.publish("portfolio", new address[](0));

        address[] memory tooMany = new address[](n.factory.MAX_CHUNKS() + 1);
        vm.expectRevert(NavikFactory.InvalidContent.selector);
        n.factory.publish("portfolio", tooMany);

        address[] memory missing = new address[](1);
        missing[0] = makeAddr("navik.test.nothingHere");
        vm.expectRevert(abi.encodeWithSelector(NavikChunks.MissingChunk.selector, missing[0]));
        n.factory.publish("portfolio", missing);

        bytes[] memory bad = new bytes[](2);
        bad[0] = "ok";
        bad[1] = new bytes(NavikChunks.CHUNK_SIZE + 1);
        vm.expectRevert(abi.encodeWithSelector(NavikFactory.InvalidChunk.selector, 1));
        n.factory.publishContent("portfolio", bad);

        bad[1] = "";
        vm.expectRevert(abi.encodeWithSelector(NavikFactory.InvalidChunk.selector, 1));
        n.factory.storeChunks(bad);
        vm.stopPrank();

        // stored chunks do not let anyone else publish
        address[] memory ps = n.factory.storeChunks(_chunks(SITE_V1));
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(NavikFactory.NotPublisher.selector, "portfolio", mallory));
        n.factory.publish("portfolio", ps);
    }

    function test_isNavikDeployment_rejectsForgedClones() public {
        _claim("portfolio", alice);
        (address d,) = _publish(alice, "portfolio", SITE_V1);
        // a clone of the implementation with copied args, but not at the factory's CREATE3 address
        bytes memory code = d.code;
        address forged = makeAddr("forged");
        vm.etch(forged, code);
        assertFalse(n.factory.isNavikDeployment(forged));
        assertFalse(n.factory.isNavikDeployment(alice));
    }

    // ------------------------------------------------------------- namespace

    function test_claim() public {
        IPermissionedResolver r = _claim("portfolio", alice);
        uint256 id = uint256(keccak256("portfolio"));
        assertEq(n.registry.getOwner(id), alice);
        assertEq(n.registry.getResolver("portfolio"), address(r));
        assertEq(n.registry.getExpiry(id), type(uint64).max, "project names never expire");
        assertEq(address(r), n.registrar.predictResolver("portfolio"));
        // the registrar keeps nothing on the project's resolver
        assertFalse(r.hasRoles(0, ENSv2Roles.ROLE_SET_TEXT, address(n.registrar)));
        assertTrue(r.hasRoles(0, ENSv2Roles.ALL_ROLES, alice));
    }

    function test_claim_rejectsTakenAndInvalid() public {
        _claim("portfolio", alice);
        vm.expectRevert(abi.encodeWithSelector(NavikRegistrar.LabelTaken.selector, "portfolio"));
        n.registrar.claim("portfolio", mallory);

        vm.expectRevert(abi.encodeWithSelector(NavikRegistrar.InvalidLabel.selector, "portfolio-v1"));
        n.registrar.claim("portfolio-v1", mallory);
        vm.expectRevert(abi.encodeWithSelector(NavikRegistrar.InvalidLabel.selector, "Portfolio"));
        n.registrar.claim("Portfolio", mallory);
    }

    function test_publish_requiresProjectOwner() public {
        vm.expectRevert(abi.encodeWithSelector(NavikFactory.ProjectNotClaimed.selector, "portfolio"));
        _publish(alice, "portfolio", SITE_V1);

        _claim("portfolio", alice);
        vm.expectRevert(abi.encodeWithSelector(NavikFactory.NotPublisher.selector, "portfolio", mallory));
        _publish(mallory, "portfolio", SITE_V1);
        // the Navik team has no special powers either
        vm.expectRevert(abi.encodeWithSelector(NavikFactory.NotPublisher.selector, "portfolio", rootOwner));
        _publish(rootOwner, "portfolio", SITE_V1);
        vm.expectRevert(abi.encodeWithSelector(NavikFactory.NotPublisher.selector, "portfolio", deployer));
        _publish(deployer, "portfolio", SITE_V1);
    }

    // ------------------------------------------------- resolution via ENSv2

    function test_promote_and_resolve() public {
        _claim("portfolio", alice);
        (address d1,) = _publish(alice, "portfolio", SITE_V1);

        // release name resolves immediately, with no ENS write
        assertEq(_text("portfolio-v1", "contentcontract"), _hex(d1));
        assertEq(_addr("portfolio-v1"), d1);
        assertEq(_text("portfolio-v1", "navik.version"), "1");
        assertEq(_text("portfolio-v1", "navik.project"), "portfolio");
        assertEq(_text("portfolio-v1", "navik.contenthash"), LibString.toHexString(uint256(keccak256(SITE_V1)), 32));

        // production is empty until promoted
        assertEq(_text("portfolio", "contentcontract"), "");
        _promote(alice, "portfolio", d1);
        assertEq(_text("portfolio", "contentcontract"), _hex(d1));
    }

    function test_rollback() public {
        _claim("portfolio", alice);
        (address d1,) = _publish(alice, "portfolio", SITE_V1);
        (address d2,) = _publish(alice, "portfolio", SITE_V2);

        _promote(alice, "portfolio", d2);
        assertEq(_text("portfolio", "contentcontract"), _hex(d2));
        _promote(alice, "portfolio", d1); // rollback: one ENS write, no upload
        assertEq(_text("portfolio", "contentcontract"), _hex(d1));
        // both releases keep their names
        assertEq(_text("portfolio-v1", "contentcontract"), _hex(d1));
        assertEq(_text("portfolio-v2", "contentcontract"), _hex(d2));
    }

    function test_demote() public {
        IPermissionedResolver r = _claim("portfolio", alice);
        (address d1,) = _publish(alice, "portfolio", SITE_V1);
        _promote(alice, "portfolio", d1);

        vm.prank(alice);
        r.setText(_dns("portfolio"), "contentcontract", "");
        assertEq(_text("portfolio", "contentcontract"), "");
        assertEq(_text("portfolio-v1", "contentcontract"), _hex(d1), "release stays");
    }

    function test_unknownReleasesDoNotResolve() public {
        _claim("portfolio", alice);
        _publish(alice, "portfolio", SITE_V1);
        _expectUnresolved("portfolio-v2"); // not published yet
        _expectUnresolved("portfolio-v0");
        _expectUnresolved("portfolio-v01");
        _expectUnresolved("nothing-v1"); // unclaimed project
        _expectUnresolved("random");
    }

    function _expectUnresolved(string memory label) internal {
        bytes memory name = _dns(label);
        vm.expectRevert();
        ur.resolve(name, abi.encodeCall(ITextResolver.text, (NavikNames.namehash(name, 0), "contentcontract")));
    }

    function test_multicallThroughUniversalResolver() public {
        _claim("portfolio", alice);
        (address d1,) = _publish(alice, "portfolio", SITE_V1);
        bytes memory name = _dns("portfolio-v1");
        bytes32 node = NavikNames.namehash(name, 0);
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(ITextResolver.text, (node, "contentcontract"));
        calls[1] = abi.encodeCall(IAddrResolver.addr, (node));
        bytes[] memory results =
            abi.decode(n.resolver.resolve(name, abi.encodeWithSignature("multicall(bytes[])", calls)), (bytes[]));
        assertEq(abi.decode(results[0], (string)), _hex(d1));
        assertEq(abi.decode(results[1], (address)), d1);
    }

    // ------------------------------------------------ permissions (ENSv2 EAC)

    function test_ciKey_previewOnly() public {
        _claim("portfolio", alice);
        _grantPublish(alice, "portfolio", ci);

        (address d1,) = _publish(ci, "portfolio", SITE_V1); // ci can ship releases...
        _promoteReverts(ci, "portfolio", d1); // ...but cannot touch production
    }

    function test_ciKey_production() public {
        _claim("portfolio", alice);
        _grantPublish(alice, "portfolio", ci);
        _grantPromote(alice, "portfolio", ci);

        (address d1,) = _publish(ci, "portfolio", SITE_V1);
        _promote(ci, "portfolio", d1);
        assertEq(_text("portfolio", "contentcontract"), _hex(d1));
    }

    function test_ciKey_revoke() public {
        IPermissionedResolver r = _claim("portfolio", alice);
        _grantPublish(alice, "portfolio", ci);
        _grantPromote(alice, "portfolio", ci);
        (address d1,) = _publish(ci, "portfolio", SITE_V1);

        vm.startPrank(alice);
        r.revokeRoles(n.factory.PUBLISH_RESOURCE(), ENSv2Roles.ROLE_SET_TEXT, ci);
        r.revokeRoles(uint256(keccak256("contentcontract")), ENSv2Roles.ROLE_SET_TEXT, ci);
        vm.stopPrank();

        vm.expectRevert(abi.encodeWithSelector(NavikFactory.NotPublisher.selector, "portfolio", ci));
        _publish(ci, "portfolio", SITE_V2);
        _promoteReverts(ci, "portfolio", d1);
        // the owner is unaffected
        _publish(alice, "portfolio", SITE_V2);
    }

    function test_ciKey_isolatedPerProject() public {
        _claim("portfolio", alice);
        _claim("blog", bob);
        _grantPublish(alice, "portfolio", ci);
        _grantPromote(alice, "portfolio", ci);
        (address d1,) = _publish(ci, "portfolio", SITE_V1);

        vm.expectRevert(abi.encodeWithSelector(NavikFactory.NotPublisher.selector, "blog", ci));
        _publish(ci, "blog", SITE_V1);
        _promoteReverts(ci, "blog", d1);
    }

    // ------------------------------------------- CROPS: nobody can take names

    function _freeze(address[] memory others) internal {
        vm.startPrank(rootOwner);
        NavikDeploy.freeze(ROOT, rootOwner, others);
        vm.stopPrank();
    }

    function test_root_repointableBeforeFreeze() public {
        uint256 id = uint256(keccak256(bytes(ROOT)));
        _claim("portfolio", alice);
        (address d1,) = _publish(alice, "portfolio", SITE_V1);
        assertFalse(NavikDeploy.isFrozen(ROOT));

        // testing phase: the owner can switch navik.eth to fixed contracts...
        vm.startPrank(rootOwner);
        Navik memory fixed_ = NavikDeploy.deploy(ROOT);
        NavikDeploy.attach(fixed_, ROOT);
        vm.stopPrank();
        assertEq(eth.getResolver(ROOT), address(fixed_.resolver));
        _expectUnresolved("portfolio-v1");

        // ...and back
        vm.startPrank(rootOwner);
        NavikDeploy.attach(n, ROOT);
        vm.stopPrank();
        assertEq(_text("portfolio-v1", "contentcontract"), _hex(d1));

        // nobody else can
        vm.startPrank(mallory);
        vm.expectRevert();
        eth.setResolver(id, mallory);
        vm.expectRevert();
        eth.setSubregistry(id, mallory);
        vm.stopPrank();
    }

    function test_freeze_isPermanent() public {
        uint256 id = uint256(keccak256(bytes(ROOT)));
        _claim("portfolio", alice);
        (address d1,) = _publish(alice, "portfolio", SITE_V1);

        _freeze(new address[](0));
        assertTrue(NavikDeploy.isFrozen(ROOT));

        vm.startPrank(rootOwner);
        vm.expectRevert();
        eth.setResolver(id, mallory);
        vm.expectRevert();
        eth.setSubregistry(id, mallory);
        vm.expectRevert(); // admin roles are gone too: they cannot be granted back
        eth.grantRoles(id, ENSv2Roles.ROLE_SET_RESOLVER, rootOwner);
        vm.stopPrank();
        assertTrue(eth.isEmancipated(), "ETHRegistry has no root override");

        // everything keeps working
        assertEq(_text("portfolio-v1", "contentcontract"), _hex(d1));
        (address d2,) = _publish(alice, "portfolio", SITE_V2);
        _promote(alice, "portfolio", d2);
        assertEq(_text("portfolio", "contentcontract"), _hex(d2));
    }

    function test_freeze_coversDelegatedHolders() public {
        uint256 id = uint256(keccak256(bytes(ROOT)));
        address hot = makeAddr("navik.test.hotWallet");
        vm.prank(rootOwner);
        eth.grantRoles(id, ENSv2Roles.ROLE_SET_RESOLVER, hot);

        // revoking only from the owner leaves the name repointable
        vm.prank(rootOwner);
        eth.revokeRoles(id, NavikDeploy.ROOT_CONTROL_ROLES, rootOwner);
        assertFalse(NavikDeploy.isFrozen(ROOT));
        vm.prank(hot);
        eth.setResolver(id, address(n.resolver));
    }

    function test_freeze_revokesDelegatedHolders() public {
        uint256 id = uint256(keccak256(bytes(ROOT)));
        address hot = makeAddr("navik.test.hotWallet");
        vm.prank(rootOwner);
        eth.grantRoles(id, ENSv2Roles.ROLE_SET_RESOLVER, hot);

        address[] memory others = new address[](1);
        others[0] = hot;
        _freeze(others);
        assertTrue(NavikDeploy.isFrozen(ROOT));
        vm.prank(hot);
        vm.expectRevert();
        eth.setResolver(id, mallory);
    }

    function test_navikRegistry_hasNoAdmin() public view {
        // the only root roles in the Navik registry: the registrar's REGISTRAR and SET_PARENT
        assertEq(n.registry.roleCount(0), ENSv2Roles.ROLE_REGISTRAR | ENSv2Roles.ROLE_SET_PARENT);
        assertTrue(n.registry.isEmancipated());
    }

    function test_projectNames_cannotBeTaken() public {
        _claim("portfolio", alice);
        uint256 id = uint256(keccak256("portfolio"));
        address[3] memory others = [rootOwner, deployer, address(n.registrar)];
        for (uint256 i; i < others.length; ++i) {
            vm.startPrank(others[i]);
            vm.expectRevert();
            n.registry.unregister(id);
            vm.expectRevert();
            n.registry.setResolver(id, mallory);
            vm.expectRevert();
            n.registry.setSubregistry(id, mallory);
            vm.stopPrank();
        }
        // not even the owner can delete it (so a label can never be re-claimed)
        vm.prank(alice);
        vm.expectRevert();
        n.registry.unregister(id);
        assertEq(n.registry.getOwner(id), alice);
    }

    function test_releaseNames_arePermanent() public {
        _claim("portfolio", alice);
        (address d1,) = _publish(alice, "portfolio", SITE_V1);
        _promote(alice, "portfolio", d1);

        // the owner may point production anywhere, or swap their resolver entirely...
        vm.prank(alice);
        n.registry.setResolver(uint256(keccak256("portfolio")), address(0));
        assertEq(n.registry.getResolver("portfolio"), address(0));

        // ...but release names are computed from the immutable factory and stay
        assertEq(_text("portfolio-v1", "contentcontract"), _hex(d1));
        assertEq(Deployment(d1).html(), string(SITE_V1));
    }

    function test_productionRepoints_onlyByOwner() public {
        _claim("portfolio", alice);
        (address d1,) = _publish(alice, "portfolio", SITE_V1);
        address[2] memory others = [rootOwner, deployer];
        for (uint256 i; i < others.length; ++i) {
            _promoteReverts(others[i], "portfolio", d1);
        }
    }
}
