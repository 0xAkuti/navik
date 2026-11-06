import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ArkivRead,
  type ArkivWrite,
  arkivChain,
  arkivReader,
  arkivWriter,
  type Ctx,
  type NavikDeployment,
  PUBLIC_SWARM_GATEWAY,
} from '@navik/sdk'
import { type Chain, createPublicClient, createWalletClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'

const DEPLOYMENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/deployments')
/** Set by bundle.ts: the public deployments, for the CLI installed outside this repo. */
declare const __NAVIK_DEPLOYMENTS__: Record<string, NavikDeployment> | undefined
const EMBEDDED = typeof __NAVIK_DEPLOYMENTS__ === 'undefined' ? {} : __NAVIK_DEPLOYMENTS__

export type GlobalOptions = { rpc?: string; deployment?: string }

export async function loadCtx(opts: GlobalOptions): Promise<Ctx> {
  const rpc = opts.rpc ?? process.env.RPC_URL ?? 'http://127.0.0.1:8545'
  const probe = createPublicClient({ transport: http(rpc) })
  const chainId = await probe.getChainId()

  const deployment = loadDeployment(chainId, opts.deployment ?? process.env.NAVIK_DEPLOYMENT)

  // a local fork (31337) runs mainnet ENSv2 state under another chain id
  const chain: Chain = chainId === mainnet.id ? mainnet : { ...mainnet, id: chainId, name: 'Mainnet fork' }
  const transport = http(rpc)
  const publicClient = createPublicClient({ chain, transport })

  const key = process.env.PRIVATE_KEY as Hex | undefined
  if (!key) return { deployment, publicClient }
  const account = privateKeyToAccount(key)
  const walletClient = createWalletClient({ account, chain, transport })
  return { deployment, publicClient, account: account.address, send: (tx) => walletClient.sendTransaction(tx) }
}

/** An explicit file, else this repo's contracts/deployments, else the ones embedded in the bundle. */
function loadDeployment(chainId: number, file?: string): NavikDeployment {
  const path = file ?? resolve(DEPLOYMENTS_DIR, `${chainId}.json`)
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8')) as NavikDeployment
  if (!file && EMBEDDED[chainId]) return EMBEDDED[chainId]
  throw new Error(`no Navik deployment for chain ${chainId} (looked for ${path}; pass --deployment <file>)`)
}

/**
 * Arkiv (release provenance and attestations): Rabdi by default. ARKIV_ACCESS_KEY lifts the public
 * endpoint's rate limit; ARKIV_RPC points elsewhere (e.g. a local node). Writes are signed by
 * ARKIV_PRIVATE_KEY, else PRIVATE_KEY: provenance is only trusted when its writer published the
 * release, so the deploy key should write it.
 */
export function arkivRpc(): string {
  return process.env.ARKIV_RPC ?? arkivChain(process.env.ARKIV_ACCESS_KEY ?? '').rpcUrls.default.http[0]
}

export function loadArkiv(): ArkivRead {
  return arkivReader(http(arkivRpc()), arkivChain(process.env.ARKIV_ACCESS_KEY ?? ''))
}

export function loadArkivWriter(): ArkivWrite {
  const key = (process.env.ARKIV_PRIVATE_KEY ?? process.env.PRIVATE_KEY) as Hex | undefined
  if (!key) throw new Error('set ARKIV_PRIVATE_KEY or PRIVATE_KEY (with tGLM on Arkiv) to write to Arkiv')
  return arkivWriter(http(arkivRpc()), privateKeyToAccount(key), arkivChain(process.env.ARKIV_ACCESS_KEY ?? ''))
}

/** Swarm: SWARM_API (bee or antd; default the public gateway, reads only) and SWARM_BATCH for uploads. */
export function swarmApi(): string {
  return process.env.SWARM_API ?? PUBLIC_SWARM_GATEWAY
}

export function swarmBatch(): string {
  const batch = process.env.SWARM_BATCH
  if (!batch) throw new Error('set SWARM_BATCH (a postage batch id) and SWARM_API (your bee or antd node) to upload to Swarm')
  return batch
}
