import type { Account, Address, Chain, Hex, PublicClient, Transport, WalletClient } from 'viem'

/** Contents of contracts/deployments/<chainId>.json (written by Deploy.s.sol). */
export type NavikDeployment = {
  chainId: number
  deployBlock: number
  root: string
  rootNode: Hex
  rootProject: string
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

export function requireWallet(ctx: Ctx): { walletClient: WalletClient<Transport, Chain, Account>; account: Account } {
  if (!ctx.walletClient || !ctx.account) throw new Error('connect a wallet to send transactions')
  return { walletClient: ctx.walletClient, account: ctx.account }
}
