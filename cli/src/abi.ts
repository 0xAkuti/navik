import { parseAbi } from 'viem'

export const registrarAbi = parseAbi([
  'function claim(string label, address owner) returns (address resolver, uint256 tokenId)',
  'function predictResolver(string label) view returns (address)',
  'error InvalidLabel(string label)',
  'error LabelTaken(string label)',
])

export const registryAbi = parseAbi([
  'function getOwner(uint256 anyId) view returns (address)',
  'function getResolver(string label) view returns (address)',
])

export const factoryAbi = parseAbi([
  'function publish(string label, bytes html) returns (address deployment, uint64 version)',
  'function canPublish(string label, address account) view returns (bool)',
  'function projectNode(string label) view returns (bytes32)',
  'function versionCount(bytes32 node) view returns (uint64)',
  'function predict(bytes32 node, uint64 version) view returns (address)',
  'function deploymentOf(bytes32 node, uint64 version) view returns (address)',
  'function isNavikDeployment(address deployment) view returns (bool)',
  'function MAX_SIZE() view returns (uint256)',
  'event DeploymentPublished(bytes32 indexed projectNode, uint64 indexed version, address indexed deployment, string label, bytes32 contentHash, address pointer, address publisher)',
  'error ProjectNotClaimed(string label)',
  'error NotPublisher(string label, address account)',
  'error InvalidContent()',
])

export const deploymentAbi = parseAbi([
  'function html() view returns (string)',
  'function manifest() view returns (bytes32 projectNode, uint64 version, bytes32 contentHash, address pointer, uint32 size)',
  'function factory() view returns (address)',
])

/** Same selector as html(): string and bytes share an ABI encoding, so this returns the exact stored bytes. */
export const deploymentRawAbi = parseAbi(['function html() view returns (bytes)'])

export const resolverAbi = parseAbi([
  'function setText(bytes name, string key, string value)',
  'function grantSetterRoles(bytes setter, address account) returns (bool)',
  'function revokeRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)',
  'function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)',
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account)',
])

/** PermissionedResolverLib.ROLE_SET_TEXT */
export const ROLE_SET_TEXT = 1n << 4n
