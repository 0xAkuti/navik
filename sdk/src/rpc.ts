import { readContract, simulateContract, waitForTransactionReceipt } from 'viem/actions'
import { type Abi, type Address, encodeFunctionData, type Hash } from 'viem'

import { type Ctx, requireWallet } from './types.ts'

// Shared by the SDK's modules; not re-exported from index.ts.

export async function read<T>(ctx: Ctx, address: Address, abi: Abi, functionName: string, args: unknown[] = []): Promise<T> {
  return (await readContract(ctx.publicClient, { address, abi, functionName, args })) as T
}

/** Simulates first (decoded revert reasons, gas estimate), then sends and waits. */
export async function write(ctx: Ctx, address: Address, abi: Abi, functionName: string, args: unknown[]): Promise<Hash> {
  const { account, send } = requireWallet(ctx)
  await simulateContract(ctx.publicClient, { address, abi, functionName, args, account })
  const hash = await send({ to: address, data: encodeFunctionData({ abi, functionName, args }) })
  const receipt = await waitForTransactionReceipt(ctx.publicClient, { hash })
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`)
  return hash
}
