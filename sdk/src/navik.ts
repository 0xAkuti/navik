import { getCode, getContractEvents, getTransactionReceipt } from 'viem/actions'
import {
  type Address,
  concatBytes,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  type Hash,
  type Hex,
  hexToBytes,
  keccak256,
  namehash,
  toHex,
  zeroAddress,
} from 'viem'

import {
  deploymentAbi,
  deploymentRawAbi,
  factoryAbi,
  registrarAbi,
  registryAbi,
  resolverAbi,
  ROLE_SET_TEXT,
  ROOT_CONTROL_ROLES,
  textResolverAbi,
  universalResolverAbi,
} from './abi.ts'
import { type InlinedAsset, storedLayout, unwrapCompressed } from './compress.ts'
import { read, write } from './rpc.ts'
import { type Ctx, requireWallet } from './types.ts'
import { dnsEncode, isValidProjectLabel, parseContentContract, textResource } from './names.ts'

export const PUBLISH_KEY = 'navik.publish'
export const PRODUCTION_KEY = 'contentcontract'

export type Permission = 'publish' | 'promote'
const permissionKey = (p: Permission) => (p === 'publish' ? PUBLISH_KEY : PRODUCTION_KEY)

// ------------------------------------------------------------------ names

export const PREVIEW_LABEL = 'preview'

export const projectName = (ctx: Ctx, project: string) => `${project}.${ctx.deployment.root}`
/** Permanent name of a release: `<N>.<project>.navik.eth`. */
export const releaseName = (ctx: Ctx, project: string, version: bigint) =>
  `${version}.${project}.${ctx.deployment.root}`
/** Follows the newest release: `preview.<project>.navik.eth`. */
export const previewName = (ctx: Ctx, project: string) => `${PREVIEW_LABEL}.${project}.${ctx.deployment.root}`

/** Short names (`portfolio`, `3.portfolio`) get the root appended; full ENS names (`alice.eth`) are kept. */
export function fullName(ctx: Ctx, name: string): string {
  const root = ctx.deployment.root
  return name === root || name.endsWith(`.${root}`) || name.endsWith('.eth') ? name : `${name}.${root}`
}

/** `portfolio`, `3.portfolio`, `preview.portfolio` (with or without `.navik.eth`) → parts. */
export function parseName(ctx: Ctx, input: string): { project: string; version?: bigint; preview?: boolean } {
  const suffix = `.${ctx.deployment.root}`
  const labels = (input.endsWith(suffix) ? input.slice(0, -suffix.length) : input).split('.')
  if (labels.length === 1) return { project: labels[0] }
  if (labels.length === 2 && labels[0] === PREVIEW_LABEL) return { project: labels[1], preview: true }
  if (labels.length === 2 && /^[1-9][0-9]*$/.test(labels[0])) return { project: labels[1], version: BigInt(labels[0]) }
  throw new Error(`not a ${ctx.deployment.root} name: ${input}`)
}

// ------------------------------------------------------------------ reads

export async function projectNode(ctx: Ctx, project: string): Promise<Hex> {
  return read(ctx, ctx.deployment.factory, factoryAbi, 'projectNode', [project])
}

export async function projectResolver(ctx: Ctx, project: string): Promise<Address> {
  const r = await read<Address>(ctx, ctx.deployment.registry, registryAbi, 'getResolver', [project])
  if (r === zeroAddress) throw new Error(`${projectName(ctx, project)} is not claimed or has no resolver`)
  return r
}

export async function projectOwner(ctx: Ctx, project: string): Promise<Address> {
  return read(ctx, ctx.deployment.registry, registryAbi, 'getOwner', [BigInt(keccak256(new TextEncoder().encode(project)))])
}

export async function deploymentOf(ctx: Ctx, project: string, version: bigint): Promise<Address> {
  const node = await projectNode(ctx, project)
  const d = await read<Address>(ctx, ctx.deployment.factory, factoryAbi, 'deploymentOf', [node, version])
  if (d === zeroAddress) throw new Error(`${releaseName(ctx, project, version)} does not exist`)
  return d
}

/** Resolves `contentcontract` the way any ENS client does: via ENSv2's UniversalResolver. */
export async function resolveContentContract(ctx: Ctx, name: string): Promise<Address | undefined> {
  const dns = dnsEncode(name)
  const data = encodeFunctionData({ abi: textResolverAbi, functionName: 'text', args: [namehash(name), PRODUCTION_KEY] })
  try {
    const [result] = await read<readonly [Hex, Address]>(ctx, ctx.deployment.universalResolver, universalResolverAbi, 'resolve', [
      dns,
      data,
    ])
    const value = decodeFunctionResult({ abi: textResolverAbi, functionName: 'text', data: result })
    return value ? parseContentContract(value) : undefined
  } catch {
    return undefined // no resolver, unknown release, or unsupported record
  }
}

export type RootStatus = {
  /** navik.eth points at this deployment's registry and resolver. */
  attached: boolean
  /** Nobody can repoint navik.eth anymore (control roles gone, ETHRegistry emancipated). */
  frozen: boolean
  owner: Address
}

export async function rootStatus(ctx: Ctx): Promise<RootStatus> {
  const d = ctx.deployment
  const label = d.root.slice(0, d.root.indexOf('.'))
  const id = BigInt(keccak256(new TextEncoder().encode(label)))
  const [subregistry, resolver, counts, emancipated, owner] = await Promise.all([
    read<Address>(ctx, d.ethRegistry, registryAbi, 'getSubregistry', [label]),
    read<Address>(ctx, d.ethRegistry, registryAbi, 'getResolver', [label]),
    read<bigint>(ctx, d.ethRegistry, registryAbi, 'roleCount', [id]),
    read<boolean>(ctx, d.ethRegistry, registryAbi, 'isEmancipated'),
    read<Address>(ctx, d.ethRegistry, registryAbi, 'getOwner', [id]),
  ])
  return {
    attached: getAddress(subregistry) === getAddress(d.registry) && getAddress(resolver) === getAddress(d.resolver),
    // roleCount packs one 4-bit assignee count per role nybble
    frozen: (counts & (ROOT_CONTROL_ROLES * 0xfn)) === 0n && emancipated,
    owner,
  }
}

type Manifest = readonly [projectNode: Hex, version: bigint, contentHash: Hex, size: number, pointers: readonly Address[]]

export type Release = {
  version: bigint
  name: string
  deployment: Address
  contentHash: Hex
  size: number
  chunks: number
}

export async function listReleases(
  ctx: Ctx,
  project: string,
): Promise<{ releases: Release[]; live?: Address; preview?: Address }> {
  const node = await projectNode(ctx, project)
  const count = await read<bigint>(ctx, ctx.deployment.factory, factoryAbi, 'versionCount', [node])
  // in parallel: over an anonymizing network each read costs a mixnet round trip
  const all = Promise.all(
    Array.from({ length: Number(count) }, async (_, i): Promise<Release> => {
      const version = BigInt(i + 1)
      const deployment = await read<Address>(ctx, ctx.deployment.factory, factoryAbi, 'predict', [node, version])
      const [, , contentHash, size, pointers] = await read<Manifest>(ctx, deployment, deploymentAbi, 'manifest')
      return { version, name: releaseName(ctx, project, version), deployment, contentHash, size, chunks: pointers.length }
    }),
  )
  const [releases, live, preview] = await Promise.all([
    all,
    resolveContentContract(ctx, projectName(ctx, project)),
    resolveContentContract(ctx, previewName(ctx, project)),
  ])
  return { releases, live, preview }
}

/** The newest release of a project, if any: what a redeploy of unchanged bytes would duplicate. */
export async function latestRelease(ctx: Ctx, project: string): Promise<Release | undefined> {
  const node = await projectNode(ctx, project)
  const version = await read<bigint>(ctx, ctx.deployment.factory, factoryAbi, 'versionCount', [node])
  if (version === 0n) return undefined
  const deployment = await read<Address>(ctx, ctx.deployment.factory, factoryAbi, 'predict', [node, version])
  const [, , contentHash, size, pointers] = await read<Manifest>(ctx, deployment, deploymentAbi, 'manifest')
  return { version, name: releaseName(ctx, project, version), deployment, contentHash, size, chunks: pointers.length }
}

export type ProjectSummary = { releases: number; live?: Address; liveVersion?: bigint }

/** What a project overview card shows: release count and what production serves. */
export async function projectSummary(ctx: Ctx, project: string): Promise<ProjectSummary> {
  const node = await projectNode(ctx, project)
  const [count, live] = await Promise.all([
    read<bigint>(ctx, ctx.deployment.factory, factoryAbi, 'versionCount', [node]),
    resolveContentContract(ctx, projectName(ctx, project)),
  ])
  const liveVersion = live
    ? await read<Manifest>(ctx, live, deploymentAbi, 'manifest').then((m) => m[1], () => undefined)
    : undefined
  return { releases: Number(count), live, liveVersion }
}

export type Verification = {
  name: string
  deployment: Address
  /** Created by the Navik factory at its CREATE3 address (not a look-alike). */
  isNavikDeployment: boolean
  project?: string
  version?: bigint
  releaseName?: string
  /** The release belongs to the project the name claims (manifest projectNode matches). */
  belongsToProject?: boolean
  contentHash: Hex
  computedHash: Hex
  hashMatches: boolean
  /** Exact stored bytes (what `html()` returns). */
  html: Uint8Array
  /** For gzip-wrapped releases: the original document and its hash. */
  original?: { html: Uint8Array; hash: Hex }
}

/** Name → contentcontract → factory check → html() → keccak256 == manifest contentHash. */
export async function verify(ctx: Ctx, name: string, opts: FetchOptions = {}): Promise<Verification> {
  const fqdn = fullName(ctx, name)
  const deployment = await resolveContentContract(ctx, fqdn)
  if (!deployment) throw new Error(`${fqdn} has no contentcontract record`)
  const root = ctx.deployment.root
  // navik.eth itself serves the root project's production
  const project =
    fqdn === root ? ctx.deployment.rootProject : fqdn.endsWith(`.${root}`) ? parseName(ctx, fqdn).project : undefined
  return verifyDeployment(ctx, deployment, fqdn, project, opts)
}

export async function verifyDeployment(
  ctx: Ctx,
  deployment: Address,
  name: string = deployment,
  expectedProject?: string,
  opts: FetchOptions = {},
): Promise<Verification> {
  const [isNavikDeployment, html] = await Promise.all([
    read<boolean>(ctx, ctx.deployment.factory, factoryAbi, 'isNavikDeployment', [deployment]),
    fetchHtml(ctx, deployment, opts),
  ])
  const computedHash = keccak256(html)
  const result: Verification = {
    name,
    deployment,
    isNavikDeployment,
    contentHash: computedHash,
    computedHash,
    hashMatches: true,
    html,
  }
  const original = await unwrapCompressed(html).catch(() => undefined)
  if (original) result.original = { html: original, hash: keccak256(original) }
  if (!isNavikDeployment) return result

  const [node, version, contentHash] = await read<Manifest>(ctx, deployment, deploymentAbi, 'manifest')
  result.version = version
  result.contentHash = contentHash
  result.hashMatches = contentHash === computedHash
  if (expectedProject) {
    result.belongsToProject = node === (await projectNode(ctx, expectedProject))
    if (result.belongsToProject) {
      result.project = expectedProject
      result.releaseName = releaseName(ctx, expectedProject, version)
    }
  }
  return result
}

export type FetchOptions = { onProgress?: (done: number, total: number) => void }

/**
 * Exact stored bytes of a release. Navik releases are read chunk by chunk, in parallel: smaller
 * responses that any RPC accepts, and fast over high-latency anonymizing networks. Any other
 * ERC-8244 contract is read with one `html()` call.
 */
export async function fetchHtml(ctx: Ctx, deployment: Address, opts: FetchOptions = {}): Promise<Uint8Array> {
  const count = await read<bigint>(ctx, deployment, deploymentAbi, 'chunkCount').catch(() => undefined)
  if (count === undefined) {
    const html = hexToBytes(await read<Hex>(ctx, deployment, deploymentRawAbi, 'html'))
    opts.onProgress?.(1, 1)
    return html
  }
  let done = 0
  opts.onProgress?.(0, Number(count))
  const parts = await Promise.all(
    Array.from({ length: Number(count) }, async (_, i) => {
      const part = hexToBytes(await read<Hex>(ctx, deployment, deploymentRawAbi, 'chunk', [BigInt(i)]))
      opts.onProgress?.(++done, Number(count))
      return part
    }),
  )
  return concatBytes(parts)
}

export type BuildComparison = {
  /** keccak256 of the local file. */
  hash: Hex
  /** The file is the release's document: its original (if gzip-wrapped) or its exact stored bytes. */
  matches: boolean
  /** Which onchain document it matched. */
  matched?: 'original' | 'stored'
}

/** Checks a local build (e.g. from a reproducible `pnpm build`) against a verified release. */
export function compareBuild(v: Verification, local: Uint8Array): BuildComparison {
  const hash = keccak256(local)
  if (v.hashMatches && v.original?.hash === hash) return { hash, matches: true, matched: 'original' }
  if (v.hashMatches && v.computedHash === hash) return { hash, matches: true, matched: 'stored' }
  return { hash, matches: false }
}

// ----------------------------------------------------------------- writes

export async function claim(ctx: Ctx, project: string, owner?: Address) {
  if (!isValidProjectLabel(project)) throw new Error(`invalid project name "${project}"`)
  const { account } = requireWallet(ctx)
  const hash = await write(ctx, ctx.deployment.registrar, registrarAbi, 'claim', [project, owner ?? account])
  const [resolver, releaseRegistry] = await Promise.all([
    read<Address>(ctx, ctx.deployment.registry, registryAbi, 'getResolver', [project]),
    read<Address>(ctx, ctx.deployment.registry, registryAbi, 'getSubregistry', [project]),
  ])
  return { hash, resolver, releaseRegistry, name: projectName(ctx, project) }
}

/**
 * Full chunks per transaction. Mainnet caps a transaction at 2^24 gas (EIP-7825) and one full
 * chunk costs ~5.4M gas to store, so two fit with room for the publish itself (measured 11.8M).
 */
export const CHUNKS_PER_TX = 2

export type PlannedChunk = { data: Uint8Array; pointer: Address; stored: boolean }

export type PublishPlan = {
  project: string
  size: number
  contentHash: Hex
  chunks: PlannedChunk[]
  /** Upload transactions for chunks not stored yet, then one publish (or one publishContent). */
  uploads: Uint8Array[][]
  singleTx: boolean
  version: bigint
  predicted: Address
  name: string
  maxSize: number
  /** Set when the site is stored gzip-wrapped (see compress.ts); `segments`: assets in chunks of their own. */
  compressed?: { originalSize: number; originalChunks: number; segments: number }
}

/** `assets`: what packSite inlined; with `compress`, large ones are stored in chunks of their own. */
export type PlanOptions = { compress?: boolean; assets?: InlinedAsset[] }

export async function planPublish(
  ctx: Ctx,
  project: string,
  input: Uint8Array,
  opts: PlanOptions = {},
): Promise<PublishPlan> {
  const f = ctx.deployment.factory
  const [chunkSize, maxChunks] = (
    await Promise.all([read<bigint>(ctx, f, factoryAbi, 'CHUNK_SIZE'), read<bigint>(ctx, f, factoryAbi, 'MAX_CHUNKS')])
  ).map(Number)
  const maxSize = chunkSize * maxChunks
  if (input.length === 0) throw new Error('empty site')
  const { bytes, regions, segments } = await storedLayout(input, opts)
  if (bytes.length > maxSize) throw new Error(`site is ${bytes.length} bytes; the limit is ${maxSize}`)

  // chunks never span two regions, so a segment's chunks depend on its bytes alone
  const chunks: PlannedChunk[] = []
  let start = 0
  for (const length of regions) {
    for (let i = start; i < start + length; i += chunkSize) {
      const data = bytes.subarray(i, Math.min(i + chunkSize, start + length))
      const pointer = await read<Address>(ctx, f, factoryAbi, 'chunkPointer', [toHex(data)])
      const code = await getCode(ctx.publicClient, { address: pointer })
      chunks.push({ data, pointer, stored: code !== undefined && code !== '0x' })
    }
    start += length
  }
  if (chunks.length > maxChunks) throw new Error(`site needs ${chunks.length} chunks; the limit is ${maxChunks}`)
  const missing = chunks.filter((c) => !c.stored).map((c) => c.data)
  const uploads: Uint8Array[][] = []
  for (let i = 0; i < missing.length; i += CHUNKS_PER_TX) uploads.push(missing.slice(i, i + CHUNKS_PER_TX))
  // all chunks new and few enough: store and publish together
  const singleTx = missing.length === chunks.length && chunks.length <= CHUNKS_PER_TX

  const node = await projectNode(ctx, project)
  const version = (await read<bigint>(ctx, f, factoryAbi, 'versionCount', [node])) + 1n
  const predicted = await read<Address>(ctx, f, factoryAbi, 'predict', [node, version])
  return {
    project,
    size: bytes.length,
    contentHash: keccak256(bytes),
    chunks,
    uploads: singleTx ? [] : uploads,
    singleTx,
    version,
    predicted,
    name: releaseName(ctx, project, version),
    maxSize,
    compressed: opts.compress
      ? { originalSize: input.length, originalChunks: Math.ceil(input.length / chunkSize), segments }
      : undefined,
  }
}

export type PublishStep = { kind: 'upload' | 'publish'; hash: Hash; gasUsed: bigint; chunks: number }

/** Runs the plan. Resumable: re-planning after a failure skips chunks that made it onchain. */
export async function publish(ctx: Ctx, plan: PublishPlan, onStep?: (step: PublishStep) => void) {
  const { account } = requireWallet(ctx)
  const f = ctx.deployment.factory
  const allowed = await read<boolean>(ctx, f, factoryAbi, 'canPublish', [plan.project, account])
  if (!allowed) throw new Error(`${account} may not publish to ${projectName(ctx, plan.project)}`)

  const steps: PublishStep[] = []
  const run = async (kind: PublishStep['kind'], chunks: number, fn: string, args: unknown[]) => {
    const hash = await write(ctx, f, factoryAbi, fn, args)
    const { gasUsed } = await getTransactionReceipt(ctx.publicClient, { hash })
    const step = { kind, hash, gasUsed, chunks }
    steps.push(step)
    onStep?.(step)
  }

  if (plan.singleTx) {
    await run('publish', plan.chunks.length, 'publishContent', [plan.project, plan.chunks.map((c) => toHex(c.data))])
  } else {
    for (const batch of plan.uploads) await run('upload', batch.length, 'storeChunks', [batch.map((c) => toHex(c))])
    await run('publish', plan.chunks.length, 'publish', [plan.project, plan.chunks.map((c) => c.pointer)])
  }
  return steps
}

/** Points `<project>.navik.eth` at a deployment: one ENS write on the project's resolver. */
export async function promote(ctx: Ctx, project: string, deployment: Address) {
  const resolver = await projectResolver(ctx, project)
  return write(ctx, resolver, resolverAbi, 'setText', [
    dnsEncode(projectName(ctx, project)),
    PRODUCTION_KEY,
    getAddress(deployment),
  ])
}

export async function demote(ctx: Ctx, project: string) {
  const resolver = await projectResolver(ctx, project)
  return write(ctx, resolver, resolverAbi, 'setText', [dnsEncode(projectName(ctx, project)), PRODUCTION_KEY, ''])
}

/** ENSv2 setter-scoped grant: `account` may set exactly one text key on this project. */
export async function grant(ctx: Ctx, project: string, account: Address, permission: Permission) {
  const resolver = await projectResolver(ctx, project)
  const setter = encodeFunctionData({
    abi: resolverAbi,
    functionName: 'setText',
    args: [dnsEncode(projectName(ctx, project)), permissionKey(permission), ''],
  })
  return write(ctx, resolver, resolverAbi, 'grantSetterRoles', [setter, account])
}

export async function revoke(ctx: Ctx, project: string, account: Address, permission: Permission) {
  const resolver = await projectResolver(ctx, project)
  return write(ctx, resolver, resolverAbi, 'revokeRoles', [
    textResource(permissionKey(permission)),
    ROLE_SET_TEXT,
    account,
  ])
}

/** What `account` may do on a project: owner, publish releases, change production. */
export async function permissionsOf(ctx: Ctx, project: string, account: Address) {
  const [owner, publish, promote] = await Promise.all([
    projectOwner(ctx, project),
    hasPermission(ctx, project, account, 'publish'),
    hasPermission(ctx, project, account, 'promote'),
  ])
  return { owner: getAddress(owner) === getAddress(account), publish, promote }
}

/**
 * Projects claimed for `owner` that it still owns. Reads registrar logs, so very large block
 * ranges may be rejected by some RPCs; callers should keep a local list as a fallback.
 */
export async function projectsOf(ctx: Ctx, owner: Address): Promise<string[]> {
  const logs = await getContractEvents(ctx.publicClient, {
    address: ctx.deployment.registrar,
    abi: registrarAbi,
    eventName: 'ProjectClaimed',
    args: { owner },
    fromBlock: BigInt(ctx.deployment.deployBlock),
  })
  const labels = [...new Set(logs.map((l) => l.args.label).filter((l): l is string => !!l))]
  const owners = await Promise.all(labels.map((l) => projectOwner(ctx, l)))
  return labels.filter((_, i) => getAddress(owners[i]) === getAddress(owner))
}

/** The account that published a release, from the factory's DeploymentPublished event. */
export async function publisherOf(ctx: Ctx, deployment: Address): Promise<Address | undefined> {
  const [log] = await getContractEvents(ctx.publicClient, {
    address: ctx.deployment.factory,
    abi: factoryAbi,
    eventName: 'DeploymentPublished',
    args: { deployment },
    fromBlock: BigInt(ctx.deployment.deployBlock),
  })
  return log?.args.publisher
}

export type KeyGrant = { account: Address; publish: boolean; promote: boolean }

/** Accounts holding a `grant`ed permission on the project's resolver right now (owner excluded). */
export async function listKeys(ctx: Ctx, project: string): Promise<KeyGrant[]> {
  const resolver = await projectResolver(ctx, project)
  const logs = await getContractEvents(ctx.publicClient, {
    address: resolver,
    abi: resolverAbi,
    eventName: 'EACRolesChanged',
    args: { resource: [textResource(PUBLISH_KEY), textResource(PRODUCTION_KEY)] },
    fromBlock: BigInt(ctx.deployment.deployBlock),
  })
  const accounts = [...new Set(logs.map((l) => l.args.account).filter((a): a is Address => !!a))]
  const grants = await Promise.all(
    accounts.map(async (account) => ({
      account,
      publish: await hasPermission(ctx, project, account, 'publish'),
      promote: await hasPermission(ctx, project, account, 'promote'),
    })),
  )
  return grants.filter((g) => g.publish || g.promote)
}

export async function hasPermission(ctx: Ctx, project: string, account: Address, permission: Permission) {
  const resolver = await projectResolver(ctx, project)
  return read<boolean>(ctx, resolver, resolverAbi, 'hasRoles', [
    textResource(permissionKey(permission)),
    ROLE_SET_TEXT,
    account,
  ])
}
