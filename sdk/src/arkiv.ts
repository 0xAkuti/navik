import {
  createPublicClient,
  createWalletClient,
  ExpirationTime,
  type PublicArkivClient,
  type WalletArkivClient,
} from '@arkiv-network/sdk'
import { rabdi } from '@arkiv-network/sdk/chains'
import { and, eq } from '@arkiv-network/sdk/query'
import { addr, bytes, defineSchema, key, str, u64 } from '@arkiv-network/sdk/schema'
import type { Account, Address, Chain, Hex, Transport } from 'viem'
import { getAddress, hexToString, stringToBytes } from 'viem'

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
  /** what produced the attestation: navik-cli, navik-dashboard, … */
  tool: str(),
})

export type ArkivRead = PublicArkivClient<Transport, Chain>
export type ArkivWrite = WalletArkivClient<Transport, Chain, Account>

/** A read client for Arkiv over any viem transport (the dashboard passes its anon-rpc one). */
export function arkivReader(transport: Transport, chain: Chain = arkivChain()): ArkivRead {
  return createPublicClient({ chain, transport }) as ArkivRead
}

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
}

export type ProvenanceInput = Omit<Provenance, keyof Meta>
export type AttestationInput = Omit<Attestation, keyof Meta>

// ------------------------------------------------------------------ reads

/** Arkiv returns at most 100 rows a page; more than that per site or project is not expected. */
const PAGE = 100

/** Provenance written for a release contract (anyone can write one; see `trustedProvenance`). */
export async function provenanceOf(arkiv: ArkivRead, chainId: number, site: Address): Promise<Provenance[]> {
  const page = await arkiv
    .select()
    .from(ProvenanceSchema)
    .where(and(eq('chainId', u64(BigInt(chainId))), eq('site', addr(getAddress(site)))))
    .limit(PAGE)
    .fetch()
  return page.entities.map(toProvenance)
}

/** Every release's provenance under a production name, e.g. portfolio.navik.eth. */
export async function provenanceOfProject(arkiv: ArkivRead, chainId: number, project: string): Promise<Provenance[]> {
  const page = await arkiv
    .select()
    .from(ProvenanceSchema)
    .where(and(eq('chainId', u64(BigInt(chainId))), eq('project', project)))
    .limit(PAGE)
    .fetch()
  return page.entities.map(toProvenance)
}

/** Everyone who rebuilt these exact bytes (or tried to): keyed by content, so any ERC-8244 site works. */
export async function attestationsOf(arkiv: ArkivRead, chainId: number, contentHash: Hex): Promise<Attestation[]> {
  const page = await arkiv
    .select()
    .from(AttestationSchema)
    .where(and(eq('chainId', u64(BigInt(chainId))), eq('contentHash', key(contentHash))))
    .limit(PAGE)
    .fetch()
  return page.entities.map(toAttestation)
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

/** Approximate wall-clock expiry (Arkiv produces a block every ~2 s). */
export function expiryDate(expiresAt: bigint, currentBlock: bigint, now = Date.now()): Date {
  return new Date(now + Number(expiresAt - currentBlock) * ARKIV_BLOCK_SECONDS * 1000)
}

// ------------------------------------------------------------------ writes

const lifetime = () => ExpirationTime.fromDays(ARKIV_LIFETIME_DAYS)
const flags = { readonly: true, permissionlessExtension: true }

export async function recordProvenance(arkiv: ArkivWrite, p: ProvenanceInput) {
  for (const field of ['name', 'project', 'repo', 'commit', 'build', 'output', 'sourceSwarm'] as const) checkStr(field, p[field])
  return arkiv.createEntity(
    ProvenanceSchema,
    {
      chainId: u64(BigInt(p.chainId)),
      site: addr(getAddress(p.site)),
      contentHash: key(p.contentHash),
      name: p.name,
      project: p.project,
      version: u64(p.version),
      repo: p.repo,
      commit: p.commit,
      build: p.build,
      output: p.output,
      ...(p.sourceSwarm ? { sourceSwarm: p.sourceSwarm } : {}),
      ...(p.sourceHash ? { sourceHash: key(p.sourceHash) } : {}),
      ...(p.notes ? { notes: bytes(stringToBytes(p.notes)) } : {}),
    },
    { expiration: lifetime(), flags },
  )
}

export async function attest(arkiv: ArkivWrite, a: AttestationInput) {
  for (const field of ['name', 'repo', 'commit', 'build', 'tool'] as const) checkStr(field, a[field])
  return arkiv.createEntity(
    AttestationSchema,
    {
      chainId: u64(BigInt(a.chainId)),
      site: addr(getAddress(a.site)),
      contentHash: key(a.contentHash),
      name: a.name,
      result: a.result,
      builtHash: key(a.builtHash),
      tool: a.tool,
      ...(a.provenance ? { provenance: key(a.provenance) } : {}),
      ...(a.repo ? { repo: a.repo } : {}),
      ...(a.commit ? { commit: a.commit } : {}),
      ...(a.build ? { build: a.build } : {}),
    },
    { expiration: lifetime(), flags },
  )
}

/** Pushes entities' expiry out to the maximum lifetime; works for any account (permissionlessExtension). */
export async function keepAlive(arkiv: ArkivWrite, keys: Hex[]) {
  if (keys.length === 0) return undefined
  return arkiv.executeBatch({ extensions: keys.map((entityKey) => ({ entityKey, expiration: lifetime() })) })
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
  }
}
