import {
  type Abi,
  type Address,
  encodeFunctionData,
  getAddress,
  type Hash,
  type Hex,
  hexToBytes,
  keccak256,
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
} from './abi.ts'
import { type Ctx, requireWallet } from './config.ts'
import { dnsEncode, isValidProjectLabel, parseContentContract, parseReleaseLabel, textResource } from './names.ts'

export const PUBLISH_KEY = 'navik.publish'
export const PRODUCTION_KEY = 'contentcontract'

export type Permission = 'publish' | 'promote'
const permissionKey = (p: Permission) => (p === 'publish' ? PUBLISH_KEY : PRODUCTION_KEY)

// ------------------------------------------------------------------ names

export const projectName = (ctx: Ctx, project: string) => `${project}.${ctx.deployment.root}`
export const releaseName = (ctx: Ctx, project: string, version: bigint) =>
  `${project}-v${version}.${ctx.deployment.root}`

/** `portfolio`, `portfolio.navik.eth`, `portfolio-v3`, `portfolio-v3.navik.eth` → parts. */
export function parseName(ctx: Ctx, input: string): { project: string; version?: bigint } {
  const suffix = `.${ctx.deployment.root}`
  const label = input.endsWith(suffix) ? input.slice(0, -suffix.length) : input
  if (label.includes('.')) throw new Error(`not a ${ctx.deployment.root} name: ${input}`)
  const release = parseReleaseLabel(label)
  return release ?? { project: label }
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
  const value = await ctx.publicClient.getEnsText({
    name,
    key: PRODUCTION_KEY,
    universalResolverAddress: ctx.deployment.universalResolver,
  })
  return value ? parseContentContract(value) : undefined
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

export type Release = {
  version: bigint
  name: string
  deployment: Address
  contentHash: Hex
  size: number
}

export async function listReleases(ctx: Ctx, project: string): Promise<{ releases: Release[]; live?: Address }> {
  const node = await projectNode(ctx, project)
  const count = await read<bigint>(ctx, ctx.deployment.factory, factoryAbi, 'versionCount', [node])
  const releases: Release[] = []
  for (let v = 1n; v <= count; v++) {
    const deployment = await read<Address>(ctx, ctx.deployment.factory, factoryAbi, 'predict', [node, v])
    const [, , contentHash, , size] = await read<readonly [Hex, bigint, Hex, Address, number]>(
      ctx,
      deployment,
      deploymentAbi,
      'manifest',
    )
    releases.push({ version: v, name: releaseName(ctx, project, v), deployment, contentHash, size })
  }
  const live = await resolveContentContract(ctx, projectName(ctx, project))
  return { releases, live }
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
  html: Uint8Array
}

/** Name → contentcontract → factory check → html() → keccak256 == manifest contentHash. */
export async function verify(ctx: Ctx, name: string): Promise<Verification> {
  const fqdn = name.includes('.') ? name : `${name}.${ctx.deployment.root}`
  const deployment = await resolveContentContract(ctx, fqdn)
  if (!deployment) throw new Error(`${fqdn} has no contentcontract record`)
  const project = fqdn.endsWith(`.${ctx.deployment.root}`) ? parseName(ctx, fqdn).project : undefined
  return verifyDeployment(ctx, deployment, fqdn, project)
}

export async function verifyDeployment(
  ctx: Ctx,
  deployment: Address,
  name: string = deployment,
  expectedProject?: string,
): Promise<Verification> {
  const isNavikDeployment = await read<boolean>(ctx, ctx.deployment.factory, factoryAbi, 'isNavikDeployment', [
    deployment,
  ])
  const raw = await read<Hex>(ctx, deployment, deploymentRawAbi, 'html')
  const html = hexToBytes(raw)
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
  if (!isNavikDeployment) return result

  const [node, version, contentHash] = await read<readonly [Hex, bigint, Hex, Address, number]>(
    ctx,
    deployment,
    deploymentAbi,
    'manifest',
  )
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

// ----------------------------------------------------------------- writes

export async function claim(ctx: Ctx, project: string, owner?: Address) {
  if (!isValidProjectLabel(project)) throw new Error(`invalid project name "${project}"`)
  const { account } = requireWallet(ctx)
  const hash = await write(ctx, ctx.deployment.registrar, registrarAbi, 'claim', [project, owner ?? account.address])
  const resolver = await read<Address>(ctx, ctx.deployment.registry, registryAbi, 'getResolver', [project])
  return { hash, resolver, name: projectName(ctx, project) }
}

export type PublishPlan = {
  project: string
  bytes: Uint8Array
  size: number
  contentHash: Hex
  version: bigint
  predicted: Address
  name: string
  maxSize: number
}

export async function planPublish(ctx: Ctx, project: string, bytes: Uint8Array): Promise<PublishPlan> {
  const maxSize = Number(await read<bigint>(ctx, ctx.deployment.factory, factoryAbi, 'MAX_SIZE'))
  if (bytes.length === 0) throw new Error('empty site')
  if (bytes.length > maxSize) throw new Error(`site is ${bytes.length} bytes; the MVP limit is ${maxSize} (one chunk)`)
  const node = await projectNode(ctx, project)
  const version = (await read<bigint>(ctx, ctx.deployment.factory, factoryAbi, 'versionCount', [node])) + 1n
  const predicted = await read<Address>(ctx, ctx.deployment.factory, factoryAbi, 'predict', [node, version])
  return {
    project,
    bytes,
    size: bytes.length,
    contentHash: keccak256(bytes),
    version,
    predicted,
    name: releaseName(ctx, project, version),
    maxSize,
  }
}

export async function publish(ctx: Ctx, plan: PublishPlan) {
  const { account } = requireWallet(ctx)
  const allowed = await read<boolean>(ctx, ctx.deployment.factory, factoryAbi, 'canPublish', [
    plan.project,
    account.address,
  ])
  if (!allowed) throw new Error(`${account.address} may not publish to ${projectName(ctx, plan.project)}`)
  const hash = await write(ctx, ctx.deployment.factory, factoryAbi, 'publish', [plan.project, toHex(plan.bytes)])
  const receipt = await ctx.publicClient.getTransactionReceipt({ hash })
  return { hash, gasUsed: receipt.gasUsed }
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

export async function hasPermission(ctx: Ctx, project: string, account: Address, permission: Permission) {
  const resolver = await projectResolver(ctx, project)
  return read<boolean>(ctx, resolver, resolverAbi, 'hasRoles', [
    textResource(permissionKey(permission)),
    ROLE_SET_TEXT,
    account,
  ])
}

// ---------------------------------------------------------------- helpers

async function read<T>(ctx: Ctx, address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
  return (await ctx.publicClient.readContract({ address, abi, functionName, args })) as T
}

/** Simulates first (decoded revert reasons, gas estimate), then sends and waits. */
async function write(ctx: Ctx, address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<Hash> {
  const { walletClient, account } = requireWallet(ctx)
  const { request } = await ctx.publicClient.simulateContract({ address, abi, functionName, args, account })
  const hash = await walletClient.writeContract(request as Parameters<typeof walletClient.writeContract>[0])
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`)
  return hash
}
