import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type Account,
  type Address,
  type Chain,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mainnet } from 'viem/chains'

export type NavikDeployment = {
  chainId: number
  deployBlock: number
  root: string
  rootNode: Hex
  registrar: Address
  registry: Address
  factory: Address
  resolver: Address
  ethRegistry: Address
  universalResolver: Address
}

export type Ctx = {
  deployment: NavikDeployment
  publicClient: PublicClient
  walletClient?: WalletClient<Transport, Chain, Account>
  account?: Account
}

const DEPLOYMENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../contracts/deployments')

export type GlobalOptions = { rpc?: string; deployment?: string }

export async function loadCtx(opts: GlobalOptions): Promise<Ctx> {
  const rpc = opts.rpc ?? process.env.RPC_URL ?? 'http://127.0.0.1:8545'
  const probe = createPublicClient({ transport: http(rpc) })
  const chainId = await probe.getChainId()

  const path = opts.deployment ?? process.env.NAVIK_DEPLOYMENT ?? resolve(DEPLOYMENTS_DIR, `${chainId}.json`)
  if (!existsSync(path)) throw new Error(`no Navik deployment for chain ${chainId} (looked for ${path})`)
  const deployment = JSON.parse(readFileSync(path, 'utf8')) as NavikDeployment

  // a local fork (31337) runs mainnet ENSv2 state under another chain id
  const chain: Chain = chainId === mainnet.id ? mainnet : { ...mainnet, id: chainId, name: 'Mainnet fork' }
  const transport = http(rpc)
  const publicClient = createPublicClient({ chain, transport }) as PublicClient

  const key = process.env.PRIVATE_KEY as Hex | undefined
  if (!key) return { deployment, publicClient }
  const account = privateKeyToAccount(key)
  const walletClient = createWalletClient({ account, chain, transport })
  return { deployment, publicClient, walletClient, account }
}

export function requireWallet(ctx: Ctx): { walletClient: WalletClient<Transport, Chain, Account>; account: Account } {
  if (!ctx.walletClient || !ctx.account) throw new Error('set PRIVATE_KEY to send transactions')
  return { walletClient: ctx.walletClient, account: ctx.account }
}
