/**
 * Runs in the headless browser (see anon.ts), bundled with the anon-rpc harness. Holds no key: it
 * gets a URL and a body, and hands back the response.
 */
import { AnonRpcWorker } from '@anon-rpc/browser-harness'
import type { AnonNetwork } from '@navik/sdk'

export type AnonStart = { id: string; specifier: `0x${string}`; config: AnonNetwork['config']; answers: Record<string, string> }
export type AnonRequest = { url: string; method?: string; headers?: Record<string, string>; body?: string; isolationKey: string }
export type AnonResponse = { status: number; statusText: string; headers: [string, string][]; body: string }

const workers = new Map<string, AnonRpcWorker>()

function start({ id, specifier, config, answers }: AnonStart) {
  const rpcProvider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      const answer = answers[(params?.[0] as { data?: string } | undefined)?.data?.slice(0, 10) ?? '']
      if (method === 'eth_call' && answer) return answer
      throw new Error(`pinned specifier: unexpected ${method}`)
    },
  }
  const worker = new AnonRpcWorker({ address: specifier, config, preExisting: { rpcProvider } })
  workers.set(id, worker)
  return worker.ready
}

async function send(id: string, { url, isolationKey, ...init }: AnonRequest): Promise<AnonResponse> {
  const worker = workers.get(id)!
  await worker.ready
  const res = await worker.fetch(url, { ...init, anonOptions: { isolationKey } })
  return { status: res.status, statusText: res.statusText, headers: [...res.headers], body: await res.text() }
}

Object.assign(globalThis, { navikAnon: { start, send } })
