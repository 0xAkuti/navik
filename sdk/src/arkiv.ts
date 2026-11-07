import { createWalletClient, ExpirationTime, SelectQueryBuilder, type WalletArkivClient } from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import { and, eq } from '@arkiv-network/sdk/query'
import { addr, bytes, defineSchema, key, str, u64 } from '@arkiv-network/sdk/schema'
import type { Account, Address, Chain, Client, Hex, Transport } from 'viem'
import {
  createClient,
  decodeEventLog,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hexToString,
  pad,
  parseAbi,
  parseAbiParameters,
  stringToBytes,
  toHex,
} from 'viem'
import { getBlockNumber } from 'viem/actions'

/**
 * Release metadata that does not belong in contract bytecode (source repo, commit, build command,
 * a Swarm copy of the source) and reproducibility attestations from anyone who rebuilt a site,
 * kept on Arkiv: public, queryable, owned by the wallet that wrote it, with no Navik server.
 *
 * Both entity kinds are created `readonly` (like the release they describe, they never change)
 * and with `permissionlessExtension` (anyone who relies on one can keep it alive past Arkiv's
 * maximum lifetime, without being able to edit it).
 *
 * Nothing here is needed to serve or verify a site: names, bytes and content hashes stay on
 * Ethereum. A client that cannot reach Arkiv just shows no provenance.
 */

/** Rabdi, Arkiv's current testnet. `accessKey` is not a secret (see `rabdi`); `""` is the public, rate-limited endpoint. */
export const arkivChain = (accessKey = ''): Chain => rabdi({ accessKey })

/** Arkiv caps a lifetime at ~182.5 days (7,884,000 two-second blocks); stay just under it. */
export const ARKIV_LIFETIME_DAYS = 180
const ARKIV_BLOCK_SECONDS = 2

/** `str` values are at most 128 bytes on Arkiv. */
const MAX_STR = 128

export const ProvenanceSchema = defineSchema('navik.provenance', {
  /** chain the site lives on (1 = mainnet) */
  chainId: u64().indexed(),
  /** the ERC-8244 contract (`contentcontract`) of the release */
  site: addr().indexed(),
  /** keccak256 of the exact bytes `html()` returns */
  contentHash: key().indexed(),
  /** the release's permanent name, e.g. 3.portfolio.navik.eth */
  name: str().indexed(),
  /** the name production is served under, e.g. portfolio.navik.eth: one query lists a project */
  project: str().indexed(),
  version: u64(),
  /** git URL of the source */
  repo: str(),
  /** full git commit hash the release was built from */
  commit: str().indexed(),
  /** shell command, run at the repo root, that builds the site */
  build: str(),
  /** path of the built file, relative to the repo root */
  output: str(),
  /** Swarm reference of `git archive <commit>` (a tar), so the source outlives the git host */
  sourceSwarm: str().optional(),
  /** keccak256 of that tar, checked after download (the gateway is not trusted) */
  sourceHash: key().optional(),
  /** release notes, UTF-8 */
  notes: bytes().optional(),
})

export const AttestationSchema = defineSchema('navik.attestation', {
  chainId: u64().indexed(),
  site: addr().indexed(),
  contentHash: key().indexed(),
  /** the name the verifier resolved */
  name: str().indexed(),
  /** `match`: the rebuild is byte-identical to the site · `mismatch`: it is not */
  result: str().indexed(),
  /** keccak256 of the rebuilt file */
  builtHash: key(),
  /** the provenance entity whose recipe was rebuilt, if any */
  provenance: key().optional(),
  repo: str().optional(),
  commit: str().optional(),
  build: str().optional(),
  /** what produced the attestation: navik-cli, navik-ci, navik-dashboard, … */
  tool: str(),
  /** a public log of the rebuild, e.g. the GitHub Actions run (https only) */
  log: str().optional(),
})

/**
 * A plain viem client: queries are built on it directly rather than through Arkiv's decorated
 * public client, which would pull every viem action into browser bundles.
 */
export type ArkivRead = Client<Transport, Chain>
export type ArkivWrite = WalletArkivClient<Transport, Chain, Account>

/** A read client for Arkiv over any viem transport (the dashboard passes its anon-rpc one). */
export function arkivReader(transport: Transport, chain: Chain = arkivChain()): ArkivRead {
  return createClient({ chain, transport })
}

const select = (arkiv: ArkivRead) => new SelectQueryBuilder(arkiv as never)

/** A write client: `account` is a local key (CLI) or a JSON-RPC account behind a wallet transport. */
export function arkivWriter(transport: Transport, account: Account | Address, chain: Chain = arkivChain()): ArkivWrite {
  return createWalletClient({ chain, transport, account }) as ArkivWrite
}

// ------------------------------------------------------------------ types

type Meta = {
  key: Hex
  /** who wrote it; fixed at creation, unlike `owner` */
  creator: Address
  /** block on Arkiv after which the entity is gone unless someone extends it */
  expiresAt: bigint
}

export type Provenance = Meta & {
  chainId: number
  site: Address
  contentHash: Hex
  name: string
  project: string
  version: bigint
  repo: string
  commit: string
  build: string
  output: string
  sourceSwarm?: string
  sourceHash?: Hex
  notes?: string
}

export type Attestation = Meta & {
  chainId: number
  site: Address
  contentHash: Hex
  name: string
  result: 'match' | 'mismatch'
  builtHash: Hex
  provenance?: Hex
  repo?: string
  commit?: string
  build?: string
  tool: string
  log?: string
}

export type ProvenanceInput = Omit<Provenance, keyof Meta>
export type AttestationInput = Omit<Attestation, keyof Meta>

// ------------------------------------------------------------------ reads

/** Arkiv returns at most 100 rows a page; more than that per site or project is not expected. */
const PAGE = 100

/** Provenance written for a release contract (anyone can write one; see `trustedProvenance`). */
export async function provenanceOf(arkiv: ArkivRead, chainId: number, site: Address): Promise<Provenance[]> {
  const page = await select(arkiv)
    .from(ProvenanceSchema)
    .where(and(eq('chainId', u64(BigInt(chainId))), eq('site', addr(getAddress(site)))))
    .limit(PAGE)
    .fetch()
  return page.entities.map(toProvenance)
}

/** Every release's provenance under a production name, e.g. portfolio.navik.eth. */
export async function provenanceOfProject(arkiv: ArkivRead, chainId: number, project: string): Promise<Provenance[]> {
  const page = await select(arkiv)
    .from(ProvenanceSchema)
    .where(and(eq('chainId', u64(BigInt(chainId))), eq('project', project)))
    .limit(PAGE)
    .fetch()
  return page.entities.map(toProvenance)
}

/** Everyone who rebuilt these exact bytes (or tried to): keyed by content, so any ERC-8244 site works. */
export async function attestationsOf(arkiv: ArkivRead, chainId: number, contentHash: Hex): Promise<Attestation[]> {
  const page = await select(arkiv)
    .from(AttestationSchema)
    .where(and(eq('chainId', u64(BigInt(chainId))), eq('contentHash', key(contentHash))))
    .limit(PAGE)
    .fetch()
  return page.entities.map(toAttestation)
}

/** The repo id in a Radicle URL (`rad://z…`, `rad:z…`, or either with a peer after it): it names the repo on any seed. */
export function radicleId(repo: string): string | undefined {
  return /^rad:(?:\/\/)?(z[1-9A-HJ-NP-Za-km-z]+)(?:\/|$)/.exec(repo)?.[1]
}

/**
 * Provenance anyone could have written is only trusted when its creator is the account that
 * published the release (`publisher`, read from the Navik factory's DeploymentPublished event).
 * Newest first, so a corrected record written later by the same publisher wins.
 */
export function trustedProvenance(records: Provenance[], publisher: Address | undefined): Provenance | undefined {
  if (!publisher) return undefined
  return records
    .filter((p) => getAddress(p.creator) === getAddress(publisher))
    .sort((a, b) => Number(b.expiresAt - a.expiresAt))[0]
}

/** Arkiv's current block, to turn `expiresAt` into a date. */
export function arkivBlock(arkiv: ArkivRead): Promise<bigint> {
  return getBlockNumber(arkiv, { cacheTime: 0 })
}

/** Approximate wall-clock expiry (Arkiv produces a block every ~2 s). */
export function expiryDate(expiresAt: bigint, currentBlock: bigint, now = Date.now()): Date {
  return new Date(now + Number(expiresAt - currentBlock) * ARKIV_BLOCK_SECONDS * 1000)
}

// ------------------------------------------------------------------ writes

const lifetime = () => ExpirationTime.fromDays(ARKIV_LIFETIME_DAYS)
const flags = { readonly: true, permissionlessExtension: true }

function provenanceValues(p: ProvenanceInput) {
  for (const field of ['name', 'project', 'repo', 'commit', 'build', 'output', 'sourceSwarm'] as const) checkStr(field, p[field])
  return {
    chainId: u64(BigInt(p.chainId)),
    site: addr(getAddress(p.site)),
    contentHash: key(p.contentHash),
    name: str(p.name),
    project: str(p.project),
    version: u64(p.version),
    repo: str(p.repo),
    commit: str(p.commit),
    build: str(p.build),
    output: str(p.output),
    ...(p.sourceSwarm ? { sourceSwarm: str(p.sourceSwarm) } : {}),
    ...(p.sourceHash ? { sourceHash: key(p.sourceHash) } : {}),
    ...(p.notes ? { notes: bytes(stringToBytes(p.notes)) } : {}),
  }
}

function attestationValues(a: AttestationInput) {
  for (const field of ['name', 'repo', 'commit', 'build', 'tool', 'log'] as const) checkStr(field, a[field])
  if (a.log && !a.log.startsWith('https://')) throw new Error(`log must be an https URL: ${a.log}`)
  return {
    chainId: u64(BigInt(a.chainId)),
    site: addr(getAddress(a.site)),
    contentHash: key(a.contentHash),
    name: str(a.name),
    result: str(a.result),
    builtHash: key(a.builtHash),
    tool: str(a.tool),
    ...(a.provenance ? { provenance: key(a.provenance) } : {}),
    ...(a.repo ? { repo: str(a.repo) } : {}),
    ...(a.commit ? { commit: str(a.commit) } : {}),
    ...(a.build ? { build: str(a.build) } : {}),
    ...(a.log ? { log: str(a.log) } : {}),
  }
}

export async function recordProvenance(arkiv: ArkivWrite, p: ProvenanceInput) {
  return arkiv.createEntity(ProvenanceSchema, provenanceValues(p), { expiration: lifetime(), flags })
}

export async function attest(arkiv: ArkivWrite, a: AttestationInput) {
  return arkiv.createEntity(AttestationSchema, attestationValues(a), { expiration: lifetime(), flags })
}

/** Pushes entities' expiry out to the maximum lifetime; works for any account (permissionlessExtension). */
export async function keepAlive(arkiv: ArkivWrite, keys: Hex[]) {
  if (keys.length === 0) return undefined
  return arkiv.executeBatch({ extensions: keys.map((entityKey) => ({ entityKey, expiration: lifetime() })) })
}

// ------------------------------------------------- writes without Arkiv's wallet client
//
// Arkiv's wallet client extends viem's full public and wallet actions, which adds ~70 KB
// (gzipped) to a browser bundle: three more onchain chunks for the dashboard. A create or an
// extension is one `execute` call, so the dashboard builds the calldata here and hands it to the
// wallet. test/arkiv-encoding.test.ts checks it is byte-identical to what the Arkiv SDK sends.

export const ARKIV_ADDRESS: Address = '0x4400000000000000000000000000000000000044'
const executeAbi = parseAbi(['function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)'])
const createParams = parseAbiParameters(
  '(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, (bytes32 name, uint8 typeId, bytes value)[] attributes)',
)
const extendParams = parseAbiParameters('(bytes32 entityKey, uint64 expiresAt, uint64 minLifetime)')
const OP_CREATE = 1
const OP_EXTEND = 3
const TYPE_ID = { u64: 3, bytes: 7, str: 8, addr: 9, key: 10 } as const
const INDEXED = 0x80
// readonly | permissionlessExtension
const CREATION_FLAGS = 0b11
const lifetimeBlocks = () => BigInt((ARKIV_LIFETIME_DAYS * 24 * 60 * 60) / ARKIV_BLOCK_SECONDS)

export type ArkivCall = { to: Address; data: Hex }

export const provenanceCall = (p: ProvenanceInput, salt = randomSalt128()): ArkivCall =>
  createCall(ProvenanceSchema, provenanceValues(p), salt)

export const attestationCall = (a: AttestationInput, salt = randomSalt128()): ArkivCall =>
  createCall(AttestationSchema, attestationValues(a), salt)

export function keepAliveCall(keys: Hex[]): ArkivCall {
  const ops = keys.map((entityKey) => ({
    operation: OP_EXTEND,
    operationData: encodeAbiParameters(extendParams, [{ entityKey, expiresAt: 0n, minLifetime: lifetimeBlocks() }]),
  }))
  return { to: ARKIV_ADDRESS, data: encodeFunctionData({ abi: executeAbi, functionName: 'execute', args: [ops] }) }
}

type Value = { type: string; value: unknown }

function createCall(schema: { tag?: Value; columns: Record<string, { isIndexed: boolean; isOptional: boolean }> }, values: Record<string, Value>, salt: bigint): ArkivCall {
  const attributes = [
    ...(schema.tag ? [attribute('arkiv.schema', schema.tag, true)] : []),
    ...Object.entries(schema.columns).flatMap(([name, column]) => {
      const value = values[name]
      if (value === undefined && !column.isOptional) throw new Error(`missing required Arkiv column ${name}`)
      return value === undefined ? [] : [attribute(name, value, column.isIndexed)]
    }),
  ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  const operationData = encodeAbiParameters(createParams, [
    { salt, expiresAt: 0n, minLifetime: lifetimeBlocks(), creationFlags: CREATION_FLAGS, attributes },
  ])
  return { to: ARKIV_ADDRESS, data: encodeFunctionData({ abi: executeAbi, functionName: 'execute', args: [[{ operation: OP_CREATE, operationData }]] }) }
}

function attribute(name: string, v: Value, indexed: boolean) {
  const type = v.type as keyof typeof TYPE_ID
  const value: Hex =
    type === 'u64'
      ? toHex(v.value as bigint, { size: 32 })
      : type === 'addr'
        ? pad((v.value as string).toLowerCase() as Hex, { size: 32 })
        : type === 'str'
          ? toHex(stringToBytes(v.value as string))
          : (v.value as Hex) // key, bytes
  if (!(type in TYPE_ID)) throw new Error(`unsupported Arkiv type ${v.type}`)
  return { name: toHex(name, { size: 32 }), typeId: TYPE_ID[type] | (indexed ? INDEXED : 0), value }
}

function randomSalt128(): bigint {
  return BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))))
}

const entityEvents = parseAbi([
  'event EntityCreated(bytes32 indexed entityKey, address indexed owner, uint64 expiresAt, uint8 creationFlags)',
])

/** The key of the entity a create transaction made, from its receipt. */
export function createdEntityKey(logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[]): Hex | undefined {
  for (const log of logs) {
    if (getAddress(log.address) !== ARKIV_ADDRESS) continue
    try {
      const ev = decodeEventLog({ abi: entityEvents, topics: log.topics as [Hex, ...Hex[]], data: log.data })
      return ev.args.entityKey
    } catch {
      // another engine event
    }
  }
  return undefined
}

// ---------------------------------------------------------------- helpers

function checkStr(field: string, value: string | undefined) {
  if (value !== undefined && new TextEncoder().encode(value).length > MAX_STR) {
    throw new Error(`${field} is longer than Arkiv's ${MAX_STR}-byte limit for indexed strings: ${value}`)
  }
}

type Row = Record<string, unknown> & { $key: Hex; $creator: Address; $expiresAt: bigint }
const val = <T>(row: Row, name: string): T | undefined => (row[name] as { value: T } | undefined)?.value

function meta(row: Row): Meta {
  return { key: row.$key, creator: getAddress(row.$creator), expiresAt: row.$expiresAt }
}

function toProvenance(entity: unknown): Provenance {
  const row = entity as Row
  const notes = val<Hex>(row, 'notes')
  return {
    ...meta(row),
    chainId: Number(val<bigint>(row, 'chainId')),
    site: getAddress(val<Address>(row, 'site')!),
    contentHash: val<Hex>(row, 'contentHash')!,
    name: val<string>(row, 'name')!,
    project: val<string>(row, 'project')!,
    version: val<bigint>(row, 'version')!,
    repo: val<string>(row, 'repo')!,
    commit: val<string>(row, 'commit')!,
    build: val<string>(row, 'build')!,
    output: val<string>(row, 'output')!,
    sourceSwarm: val<string>(row, 'sourceSwarm'),
    sourceHash: val<Hex>(row, 'sourceHash'),
    notes: notes ? hexToString(notes) : undefined,
  }
}

function toAttestation(entity: unknown): Attestation {
  const row = entity as Row
  return {
    ...meta(row),
    chainId: Number(val<bigint>(row, 'chainId')),
    site: getAddress(val<Address>(row, 'site')!),
    contentHash: val<Hex>(row, 'contentHash')!,
    name: val<string>(row, 'name')!,
    result: val<string>(row, 'result') === 'match' ? 'match' : 'mismatch',
    builtHash: val<Hex>(row, 'builtHash')!,
    provenance: val<Hex>(row, 'provenance'),
    repo: val<string>(row, 'repo'),
    commit: val<string>(row, 'commit'),
    build: val<string>(row, 'build'),
    tool: val<string>(row, 'tool') ?? '',
    log: val<string>(row, 'log'),
  }
}
