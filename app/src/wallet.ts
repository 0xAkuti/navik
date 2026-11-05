import type { Ctx, NavikDeployment } from '@navik/sdk'
import { type Address, type Chain, createClient, custom, type EIP1193Provider, getAddress, type Hex } from 'viem'
import { mainnet } from 'viem/chains'

declare const __NAVIK_DEPLOYMENTS__: Record<string, NavikDeployment>

/** Navik deployments embedded at build time, by chain id. */
export const deployments: Record<number, NavikDeployment> = Object.fromEntries(
  Object.entries(__NAVIK_DEPLOYMENTS__).map(([id, d]) => [Number(id), d]),
)

export type WalletInfo = { id: string; name: string; icon?: string; provider: EIP1193Provider }

type AnnounceEvent = CustomEvent<{ info: { uuid: string; name: string; icon: string }; provider: EIP1193Provider }>

/** EIP-6963 wallet discovery, with `window.ethereum` as a fallback. */
export function discoverWallets(onChange: (wallets: WalletInfo[]) => void): () => void {
  const found = new Map<string, WalletInfo>()
  const emit = () => onChange([...found.values()])
  const onAnnounce = (e: Event) => {
    const { info, provider } = (e as AnnounceEvent).detail
    found.set(info.uuid, { id: info.uuid, name: info.name, icon: info.icon, provider })
    emit()
  }
  window.addEventListener('eip6963:announceProvider', onAnnounce)
  window.dispatchEvent(new Event('eip6963:requestProvider'))
  const injected = (window as { ethereum?: EIP1193Provider }).ethereum
  const fallback = setTimeout(() => {
    if (found.size === 0 && injected) {
      found.set('injected', { id: 'injected', name: 'Browser wallet', provider: injected })
      emit()
    }
  }, 300)
  return () => {
    window.removeEventListener('eip6963:announceProvider', onAnnounce)
    clearTimeout(fallback)
  }
}

function chainFor(id: number): Chain {
  return id === mainnet.id ? mainnet : { ...mainnet, id, name: `Chain ${id}` }
}

/** Every read and write goes through the connected wallet's own RPC: no extra servers. */
export function makeCtx(provider: EIP1193Provider, chainId: number, account?: Address): Ctx | undefined {
  const deployment = deployments[chainId]
  if (!deployment) return undefined
  const chain = chainFor(chainId)
  const transport = custom(provider)
  const publicClient = createClient({ chain, transport })
  if (!account) return { deployment, publicClient }
  // the wallet estimates gas, signs and broadcasts
  const send = (tx: { to: Address; data: Hex }) =>
    provider.request({ method: 'eth_sendTransaction', params: [{ from: account, to: tx.to, data: tx.data }] })
  return { deployment, publicClient, account, send }
}

export async function readChainId(provider: EIP1193Provider): Promise<number> {
  return Number(await provider.request({ method: 'eth_chainId' }))
}

export async function requestAccount(provider: EIP1193Provider): Promise<Address> {
  const [account] = await provider.request({ method: 'eth_requestAccounts' })
  if (!account) throw new Error('the wallet returned no account')
  return getAddress(account)
}

export async function switchChain(provider: EIP1193Provider, chainId: number) {
  await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: `0x${chainId.toString(16)}` }] })
}

/** localStorage that tolerates sandboxed contexts (contract-hosted apps often run in opaque origins). */
export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key)
      return v ? (JSON.parse(v) as T) : fallback
    } catch {
      return fallback
    }
  },
  set(key: string, value: unknown) {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch {
      // storage unavailable: the list is just not remembered
    }
  },
}
