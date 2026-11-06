import { getContractEvents } from 'viem/actions'
import { type Address, decodeFunctionResult, encodeFunctionData, getAddress, type Hash, type Hex, keccak256, namehash, toBytes, zeroAddress } from 'viem'

import { registryAbi, resolverAbi, ROLE_LINK, ROLE_SET_RESOLVER, ROLE_SET_SUBREGISTRY, ROLE_SET_TEXT, textResolverAbi } from './abi.ts'
import { dnsDecode, dnsEncode } from './names.ts'
import { projectName, projectNode, projectResolver } from './navik.ts'
import { read, write } from './rpc.ts'
import type { Ctx } from './types.ts'

/*
 * Custom domains: `alice.eth` serves a project's production, and `3.alice.eth` / `preview.alice.eth`
 * its releases. ENSv2 aliasing has two halves, held by different contracts:
 *   - record aliasing: the project's resolver maps `alice.eth` onto the project's record
 *     (`linkToNode`), so it follows every promotion. Needs the project owner (ROLE_LINK).
 *   - namespace aliasing: `alice.eth` uses the project's resolver and its release registry as
 *     subregistry. Needs the domain owner (two registry writes; registries have no multicall).
 * The project side goes first and records what the domain pointed at before, so `unlinkDomain`
 * can put it back.
 */

export type DomainStep = 'record' | 'resolver' | 'subregistry'
export const DOMAIN_STEPS: readonly DomainStep[] = ['record', 'resolver', 'subregistry']

export type Domain = {
  name: string
  /** The registry holding the name, and its label there. */
  registry: Address
  label: string
  owner: Address
  /** What the name points at now. */
  resolver: Address
  subregistry: Address
  /** Which parts of the link are in place; all three: linked. */
  done: Record<DomainStep, boolean>
  linked: boolean
  /** What the name pointed at before it was linked (recorded on the project's resolver). */
  previous?: { resolver: Address; subregistry: Address }
  /** What `ctx.account` may change (all false without an account). */
  can: Record<DomainStep, boolean>
}

/** Text key on the project's own record holding a linked domain's previous pointers. */
export const domainRestoreKey = (name: string) => `navik.domain:${name}`

const same = (a: Address, b: Address) => getAddress(a) === getAddress(b)

/** The registry that holds `name` (a .eth name or a subname of one) and the name's label in it. */
async function findRegistry(ctx: Ctx, name: string): Promise<{ registry: Address; label: string }> {
  const root = ctx.deployment.root
  if (name === root || name.endsWith(`.${root}`)) throw new Error(`${name} is already a ${root} name`)
  if (!name.endsWith('.eth') || name.split('.').length < 2) throw new Error(`${name} is not a .eth name`)
  const labels = name.split('.').slice(0, -1)
  let registry = ctx.deployment.ethRegistry
  for (let i = labels.length - 1; i > 0; i--) {
    const parent = labels.slice(i).join('.') + '.eth'
    registry = await read<Address>(ctx, registry, registryAbi, 'getSubregistry', [labels[i]])
    if (registry === zeroAddress) throw new Error(`${parent} has no subname registry, so ${name} does not exist`)
  }
  return { registry, label: labels[0] }
}

/** A text record straight from a Permissioned Resolver (it answers only through ENSIP-10 `resolve`). */
async function readText(ctx: Ctx, resolver: Address, name: string, key: string): Promise<string> {
  const data = encodeFunctionData({ abi: textResolverAbi, functionName: 'text', args: [namehash(name), key] })
  const result = await read<Hex>(ctx, resolver, resolverAbi, 'resolve', [dnsEncode(name), data])
  return decodeFunctionResult({ abi: textResolverAbi, functionName: 'text', data: result })
}

const labelId = (label: string) => BigInt(keccak256(toBytes(label)))

/** How far `name` is linked to `project`, and what `ctx.account` may do about it. */
export async function domainStatus(ctx: Ctx, project: string, name: string): Promise<Domain> {
  name = name.toLowerCase()
  const { registry, label } = await findRegistry(ctx, name)
  const id = labelId(label)
  const [owner, resolver, subregistry, projectRes, releases, pNode] = await Promise.all([
    read<Address>(ctx, registry, registryAbi, 'getOwner', [id]),
    read<Address>(ctx, registry, registryAbi, 'getResolver', [label]),
    read<Address>(ctx, registry, registryAbi, 'getSubregistry', [label]),
    projectResolver(ctx, project),
    read<Address>(ctx, ctx.deployment.registry, registryAbi, 'getSubregistry', [project]),
    projectNode(ctx, project),
  ])
  if (owner === zeroAddress) throw new Error(`${name} is not registered`)
  const [projectRecord, domainRecord, restore] = await Promise.all([
    read<bigint>(ctx, projectRes, resolverAbi, 'getRecordId', [pNode]),
    read<bigint>(ctx, projectRes, resolverAbi, 'getRecordId', [namehash(name)]),
    readText(ctx, projectRes, projectName(ctx, project), domainRestoreKey(name)),
  ])
  const done = {
    record: projectRecord !== 0n && domainRecord === projectRecord,
    resolver: same(resolver, projectRes),
    subregistry: same(subregistry, releases),
  }
  const [prevResolver, prevSubregistry] = restore.split(' ')
  const account = ctx.account
  const can = account
    ? await Promise.all([
        read<boolean>(ctx, projectRes, resolverAbi, 'hasRootRoles', [ROLE_LINK | ROLE_SET_TEXT, account]),
        read<boolean>(ctx, registry, registryAbi, 'hasRoles', [id, ROLE_SET_RESOLVER, account]),
        read<boolean>(ctx, registry, registryAbi, 'hasRoles', [id, ROLE_SET_SUBREGISTRY, account]),
      ]).then(([record, resolver, subregistry]) => ({ record, resolver, subregistry }))
    : { record: false, resolver: false, subregistry: false }
  return {
    name,
    registry,
    label,
    owner,
    resolver,
    subregistry,
    done,
    linked: done.record && done.resolver && done.subregistry,
    previous: restore ? { resolver: prevResolver as Address, subregistry: prevSubregistry as Address } : undefined,
    can,
  }
}

export type DomainChange = {
  /** Transactions sent, in order. */
  sent: { step: DomainStep; hash: Hash }[]
  /** Steps still needed that `ctx.account` may not do: the domain or project owner must. */
  waiting: DomainStep[]
}

/**
 * Makes `name` serve `project`: production at the name itself, releases at `<N>.<name>` and
 * `preview.<name>`. Sends the steps `ctx.account` may do (up to 3 transactions; fewer if some
 * are in place) and reports the rest. Re-run to finish after the other party has done theirs.
 */
export async function linkDomain(
  ctx: Ctx,
  project: string,
  name: string,
  onStep?: (step: DomainStep, hash: Hash) => void,
): Promise<DomainChange> {
  const d = await domainStatus(ctx, project, name)
  const [resolver, releases] = await Promise.all([
    projectResolver(ctx, project),
    read<Address>(ctx, ctx.deployment.registry, registryAbi, 'getSubregistry', [project]),
  ])
  const change: DomainChange = { sent: [], waiting: [] }
  const run = async (step: DomainStep, fn: () => Promise<Hash>) => {
    if (d.done[step]) return
    if (!d.can[step]) return void change.waiting.push(step)
    const hash = await fn()
    change.sent.push({ step, hash })
    onStep?.(step, hash)
  }

  await run('record', async () => {
    const projectDns = dnsEncode(projectName(ctx, project))
    const calls: Hex[] = []
    // remember what the domain points at now (unless that is already the project)
    if (!d.previous) {
      const before = `${d.done.resolver ? zeroAddress : d.resolver} ${d.done.subregistry ? zeroAddress : d.subregistry}`
      calls.push(encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [projectDns, domainRestoreKey(d.name), before] }))
    }
    calls.push(
      encodeFunctionData({ abi: resolverAbi, functionName: 'linkToNode', args: [dnsEncode(d.name), await projectNode(ctx, project)] }),
    )
    return write(ctx, resolver, resolverAbi, 'multicall', [calls])
  })
  await run('resolver', () => write(ctx, d.registry, registryAbi, 'setResolver', [labelId(d.label), resolver]))
  await run('subregistry', () => write(ctx, d.registry, registryAbi, 'setSubregistry', [labelId(d.label), releases]))
  return change
}

/**
 * Stops `name` from serving `project`: the domain gets back the resolver and subregistry it had
 * before linking (zero if unknown), and the project's resolver drops the alias. Parts that still
 * point elsewhere are left alone.
 */
export async function unlinkDomain(
  ctx: Ctx,
  project: string,
  name: string,
  onStep?: (step: DomainStep, hash: Hash) => void,
): Promise<DomainChange> {
  const d = await domainStatus(ctx, project, name)
  const resolver = await projectResolver(ctx, project)
  const change: DomainChange = { sent: [], waiting: [] }
  const run = async (step: DomainStep, fn: () => Promise<Hash>) => {
    if (!d.done[step]) return
    if (!d.can[step]) return void change.waiting.push(step)
    const hash = await fn()
    change.sent.push({ step, hash })
    onStep?.(step, hash)
  }

  await run('subregistry', () =>
    write(ctx, d.registry, registryAbi, 'setSubregistry', [labelId(d.label), d.previous?.subregistry ?? zeroAddress]),
  )
  await run('resolver', () =>
    write(ctx, d.registry, registryAbi, 'setResolver', [labelId(d.label), d.previous?.resolver ?? zeroAddress]),
  )
  await run('record', () => {
    const projectDns = dnsEncode(projectName(ctx, project))
    return write(ctx, resolver, resolverAbi, 'multicall', [
      [
        encodeFunctionData({ abi: resolverAbi, functionName: 'linkToRecord', args: [dnsEncode(d.name), 0n] }),
        encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [projectDns, domainRestoreKey(d.name), ''] }),
      ],
    ])
  })
  return change
}

/**
 * Domains whose record is linked to the project, from the project resolver's `Linked` events,
 * each with its current status (some may only be partly linked).
 */
export async function listDomains(ctx: Ctx, project: string): Promise<Domain[]> {
  const [resolver, pNode] = await Promise.all([projectResolver(ctx, project), projectNode(ctx, project)])
  const recordId = await read<bigint>(ctx, resolver, resolverAbi, 'getRecordId', [pNode])
  if (recordId === 0n) return []
  const logs = await getContractEvents(ctx.publicClient, {
    address: resolver,
    abi: resolverAbi,
    eventName: 'Linked',
    args: { recordId },
    fromBlock: BigInt(ctx.deployment.deployBlock),
  })
  const names = [
    ...new Set(logs.filter((l) => l.args.node !== pNode && l.args.name).map((l) => dnsDecode(l.args.name as Hex))),
  ]
  const domains = await Promise.all(names.map((n) => domainStatus(ctx, project, n).catch(() => undefined)))
  return domains.filter((d): d is Domain => !!d && d.done.record)
}
