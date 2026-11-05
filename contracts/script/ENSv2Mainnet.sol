// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

/// ENSv2 mainnet deployment (docs.ens.domains/learn/deployments, verified on Etherscan/Blockscout).
library ENSv2Mainnet {
    address internal constant ROOT_REGISTRY = 0x2553c09bE6447BeFfdB86FA622ad41fB8f77A91e;
    address internal constant ETH_REGISTRY = 0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2;
    address internal constant ETH_REGISTRAR = 0xD6D8369e55c94Ae8AFA714E6cF7AB5bE54D5CC81;
    address internal constant VERIFIABLE_FACTORY = 0x77510ba162dfeA3d8989E3f0928a691B345730D2;
    address internal constant PERMISSIONED_RESOLVER_IMPL = 0x565b0F456a04Ac9b48758190e90030623Cff57C5;
    address internal constant USER_REGISTRY_IMPL = 0xFAA23592ACA10A6d8875b18eA86954e8EB6d8d72;
    address internal constant UNIVERSAL_RESOLVER = 0x06Fdd07F007ADaC667177b46aB2EB9A75132Cfd5;

    /// Roles ETHRegistrar grants a .eth owner (ETHRegistrar.REGISTRATION_ROLE_BITMAP).
    uint256 internal constant ETH_OWNER_ROLES =
        (1 << 20) | ((1 << 20) << 128) | (1 << 24) | ((1 << 24) << 128) | ((1 << 28) << 128);
}
