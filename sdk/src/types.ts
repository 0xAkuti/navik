import type { Address, Chain, Client, Hash, Hex, Transport } from 'viem'

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
  /** NavikPages: serves project names to gateways like eth.limo. */
  pages: Address
  ethRegistry: Address
  universalResolver: Address
}

/** Sends a transaction from `Ctx.account` and returns its hash (the caller signs: wallet or key). */
export type Send = (tx: { to: Address; data: Hex }) => Promise<Hash>

/**
 * `publicClient` is a plain viem client: the SDK calls tree-shakable actions (`viem/actions`) on
 * it, so browser bundles only include what is used. Writing needs `account` and `send`.
 */
export type Ctx = {
  deployment: NavikDeployment
  publicClient: Client<Transport, Chain>
  account?: Address
  send?: Send
}

export function requireWallet(ctx: Ctx): { account: Address; send: Send } {
  if (!ctx.send || !ctx.account) throw new Error('connect a wallet to send transactions')
  return { account: ctx.account, send: ctx.send }
}
