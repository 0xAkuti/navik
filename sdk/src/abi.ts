import { parseAbi } from 'viem'

export const registrarAbi = parseAbi([
  'function claim(string label, address owner) returns (address resolver, address releaseRegistry, uint256 tokenId)',
  'function predictResolver(string label) view returns (address)',
  'event ProjectClaimed(bytes32 indexed node, string label, address indexed owner, address resolver, address releaseRegistry, uint256 tokenId)',
  'error InvalidLabel(string label)',
  'error LabelTaken(string label)',
])

export const registryAbi = parseAbi([
  'function getOwner(uint256 anyId) view returns (address)',
  'function getResolver(string label) view returns (address)',
  'function getSubregistry(string label) view returns (address)',
  'function roleCount(uint256 anyId) view returns (uint256)',
  'function isEmancipated() view returns (bool)',
  'function hasRoles(uint256 anyId, uint256 roleBitmap, address account) view returns (bool)',
  'function setSubregistry(uint256 anyId, address registry)',
  'function setResolver(uint256 anyId, address resolver)',
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
])

/** ENSv2Roles: change a name's subregistry / resolver. */
export const ROLE_SET_SUBREGISTRY = 1n << 20n
export const ROLE_SET_RESOLVER = 1n << 24n

/** Roles on the root name that can repoint the namespace (set subregistry/resolver + admins). */
export const ROOT_CONTROL_ROLES = (1n << 20n) | ((1n << 20n) << 128n) | (1n << 24n) | ((1n << 24n) << 128n)

export const factoryAbi = parseAbi([
  'function storeChunks(bytes[] chunks) returns (address[] pointers)',
  'function chunkPointer(bytes chunk) view returns (address)',
  'function publish(string label, address[] pointers) returns (address deployment, uint64 version)',
  'function publishContent(string label, bytes[] chunks) returns (address deployment, uint64 version)',
  'function canPublish(string label, address account) view returns (bool)',
  'function projectNode(string label) view returns (bytes32)',
  'function versionCount(bytes32 node) view returns (uint64)',
  'function predict(bytes32 node, uint64 version) view returns (address)',
  'function deploymentOf(bytes32 node, uint64 version) view returns (address)',
  'function isNavikDeployment(address deployment) view returns (bool)',
  'function CHUNK_SIZE() view returns (uint256)',
  'function MAX_CHUNKS() view returns (uint256)',
  'event DeploymentPublished(bytes32 indexed projectNode, uint64 indexed version, address indexed deployment, string label, bytes32 contentHash, uint32 size, uint16 chunkCount, address publisher)',
  'error ProjectNotClaimed(string label)',
  'error NotPublisher(string label, address account)',
  'error InvalidContent()',
  'error InvalidChunk(uint256 index)',
  'error MissingChunk(address pointer)',
])

export const deploymentAbi = parseAbi([
  'function html() view returns (string)',
  'function manifest() view returns (bytes32 projectNode, uint64 version, bytes32 contentHash, uint32 size, address[] pointers)',
  'function chunkCount() view returns (uint256)',
  'function factory() view returns (address)',
])

/** Same selector as html(): string and bytes share an ABI encoding, so this returns the exact stored bytes. */
export const deploymentRawAbi = parseAbi([
  'function html() view returns (bytes)',
  'function chunk(uint256 i) view returns (bytes)',
])

export const resolverAbi = parseAbi([
  'function setText(bytes name, string key, string value)',
  'function grantSetterRoles(bytes setter, address account) returns (bool)',
  'function revokeRoles(uint256 resource, uint256 roleBitmap, address account) returns (bool)',
  'function hasRoles(uint256 resource, uint256 roleBitmap, address account) view returns (bool)',
  'function hasRootRoles(uint256 roleBitmap, address account) view returns (bool)',
  'function resolve(bytes name, bytes data) view returns (bytes)',
  'function linkToNode(bytes name, bytes32 node)',
  'function linkToRecord(bytes name, uint256 recordId)',
  'function getRecordId(bytes32 node) view returns (uint256)',
  'function multicall(bytes[] calls) returns (bytes[] results)',
  'event EACRolesChanged(uint256 indexed resource, address indexed account, uint256 oldRoleBitmap, uint256 newRoleBitmap)',
  'event Linked(uint256 indexed recordId, bytes32 indexed node, bytes name)',
  'error InvalidRecord()',
  'error EACUnauthorizedAccountRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACCannotGrantRoles(uint256 resource, uint256 roleBitmap, address account)',
  'error EACCannotRevokeRoles(uint256 resource, uint256 roleBitmap, address account)',
])

/** PermissionedResolverLib.ROLE_SET_TEXT */
export const ROLE_SET_TEXT = 1n << 4n
/** PermissionedResolverLib.ROLE_LINK: point another name at one of the resolver's records. */
export const ROLE_LINK = 1n << 28n

export const universalResolverAbi = parseAbi([
  'function resolve(bytes name, bytes data) view returns (bytes result, address resolver)',
])

export const textResolverAbi = parseAbi(['function text(bytes32 node, string key) view returns (string)'])
