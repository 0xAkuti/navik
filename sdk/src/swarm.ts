import { type Hex, keccak256 } from 'viem'

/**
 * Release sources on Swarm, through the bee HTTP API (bee, Freedom's antd, or a gateway).
 * A source is one file, the tar from `git archive <commit>`: its Swarm reference is recorded in
 * the release's Arkiv provenance next to its keccak256, which a downloader checks, so a gateway
 * cannot hand out different source under the same reference unnoticed.
 */

/** Reads only; uploads need a node with a postage batch (SWARM_API + SWARM_BATCH). */
export const PUBLIC_SWARM_GATEWAY = 'https://api.gateway.ethswarm.org'

const REF = /^[0-9a-f]{64}$/

export function isSwarmReference(ref: string): boolean {
  return REF.test(ref)
}

/** Where a person can open a reference: `bzz://` in Swarm-native browsers (Freedom), else a gateway. */
export function swarmLinks(ref: string, gateway = PUBLIC_SWARM_GATEWAY) {
  return { bzz: `bzz://${ref}`, gateway: `${gateway.replace(/\/$/, '')}/bzz/${ref}/` }
}

export async function swarmUpload(
  api: string,
  batch: string,
  data: Uint8Array,
  opts: { name: string; contentType: string },
): Promise<{ reference: string; hash: Hex }> {
  const url = `${api.replace(/\/$/, '')}/bzz?name=${encodeURIComponent(opts.name)}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': opts.contentType, 'swarm-postage-batch-id': batch.replace(/^0x/, '') },
    body: new Blob([data as Uint8Array<ArrayBuffer>]),
  })
  if (!res.ok) throw new Error(`Swarm upload to ${api} failed: ${res.status} ${await res.text()}`)
  const { reference } = (await res.json()) as { reference?: string }
  if (!reference || !isSwarmReference(reference)) {
    throw new Error(`Swarm upload returned no usable reference${reference ? ` (${reference}: encrypted?)` : ''}`)
  }
  return { reference, hash: keccak256(data) }
}

/** Downloads a single-file reference and, given `expectedHash`, refuses bytes that do not match it. */
export async function swarmDownload(api: string, reference: string, expectedHash?: Hex): Promise<Uint8Array> {
  if (!isSwarmReference(reference)) throw new Error(`not a Swarm reference: ${reference}`)
  const res = await fetch(`${api.replace(/\/$/, '')}/bzz/${reference}/`)
  if (!res.ok) throw new Error(`Swarm download of ${reference} from ${api} failed: ${res.status}`)
  const data = new Uint8Array(await res.arrayBuffer())
  if (expectedHash && keccak256(data) !== expectedHash) {
    throw new Error(`Swarm content for ${reference} does not match its recorded hash ${expectedHash}`)
  }
  return data
}
