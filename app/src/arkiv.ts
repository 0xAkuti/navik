import * as navik from '@navik/sdk'
import type { Address, EIP1193Provider, Hash, Hex } from 'viem'
import { waitForTransactionReceipt } from 'viem/actions'

import { ARKIV_CHAIN_ID, readTransport } from './reads.ts'
import { switchChain } from './wallet.ts'

/**
 * Release provenance and attestations on Arkiv. Reads go through the anon-rpc route for Arkiv
 * (Nox by default), like every other read; the wallet only signs attestations and extensions.
 */
const chain = navik.arkivChain()
export const ARKIV_EXPLORER = chain.blockExplorers!.default.url

export const entityUrl = (key: string) => `${ARKIV_EXPLORER}/entity/${key}`

export function arkivRead(isolationKey?: string): navik.ArkivRead {
  return navik.arkivReader(readTransport(ARKIV_CHAIN_ID, isolationKey), chain)
}

/**
 * Sends an Arkiv write (calldata from the SDK's lean encoders) with the wallet, then waits for it
 * through the anon-rpc route: the wallet signs and broadcasts, it reads nothing.
 */
export async function sendArkiv(
  provider: EIP1193Provider,
  account: Address,
  call: navik.ArkivCall,
  isolationKey?: string,
): Promise<{ txHash: Hash; entityKey?: Hex }> {
  const txHash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: account, to: call.to, data: call.data }] })
  const receipt = await waitForTransactionReceipt(arkivRead(isolationKey), { hash: txHash })
  if (receipt.status !== 'success') throw new Error(`Arkiv transaction ${txHash} reverted`)
  return { txHash, entityKey: navik.createdEntityKey(receipt.logs) }
}

/** Runs `fn` with the wallet on Arkiv (adding the chain if needed), then switches back. */
export async function onArkiv<T>(provider: EIP1193Provider, fn: () => Promise<T>): Promise<T> {
  const previous = Number(await provider.request({ method: 'eth_chainId' }))
  if (previous !== ARKIV_CHAIN_ID) {
    await switchChain(provider, ARKIV_CHAIN_ID).catch(async (err: { code?: number }) => {
      if (err?.code !== 4902) throw err
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: `0x${ARKIV_CHAIN_ID.toString(16)}`,
            chainName: 'Arkiv Rabdi (testnet)',
            nativeCurrency: chain.nativeCurrency,
            rpcUrls: chain.rpcUrls.default.http,
            blockExplorerUrls: [ARKIV_EXPLORER],
          },
        ],
      })
    })
  }
  try {
    return await fn()
  } finally {
    if (previous !== ARKIV_CHAIN_ID) await switchChain(provider, previous).catch(() => undefined)
  }
}
