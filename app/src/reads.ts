import { AnonRpcWorker } from '@anon-rpc/browser-harness'
import { useEffect, useState } from 'preact/hooks'
import {
  type AnonNetwork,
  ANON_TRANSPORT,
  ARKIV_CHAIN_ID,
  defaultSettings,
  networkById,
  type NetworkId,
  NETWORKS,
  pinnedAnswers,
  PUBLIC_RPCS,
  type ReadSettings,
  UNSUPPORTED,
} from '@navik/sdk'
import { type EIP1193Provider, http, type Transport } from 'viem'

import { store } from './store.ts'

export { ARKIV_CHAIN_ID, defaultSettings, networkById, NETWORKS, PUBLIC_RPCS, UNSUPPORTED }
export type { AnonNetwork, NetworkId, ReadSettings }

/**
 * Every chain read goes through an anon-rpc network by default: the RPC provider sees a mixnet
 * exit, not the user's IP, so it cannot tie "who" to the names, projects and accounts being read.
 * Only signing and broadcasting go to the wallet (a broadcast transaction is public anyway).
 */

// ------------------------------------------------------------------ traffic log

/** anon: through an anon-rpc worker · direct: straight to the RPC · wallet: to the connected wallet */
export type Route = 'anon' | 'direct' | 'wallet'

export type Entry = {
  id: number
  at: number
  route: Route
  /** network name, RPC host, or wallet name */
  via: string
  methods: string[]
  ms?: number
  bytes?: number
  error?: string
  /** whether the network actually anonymizes (passthrough does not) */
  anonymous: boolean
}

export type Phase = 'idle' | 'connecting' | 'ready' | 'failed'

type State = {
  /** the chain the dashboard manages; `settings`, `phase` and `error` describe its reads */
  chainId?: number
  settings?: ReadSettings
  phase: Phase
  error?: string
  /** settings of every chain read so far (the main chain and Arkiv) */
  routes: Record<number, ReadSettings>
  /** per anon network: workers are shared by every chain routed through them */
  phases: Partial<Record<AnonNetwork['id'], { phase: Phase; error?: string }>>
  entries: Entry[]
  /** individual JSON-RPC calls (a batch counts each call) and response bytes, by route */
  calls: Record<Route, number>
  bytes: Record<Route, number>
  logs: string[]
}

const MAX_ENTRIES = 300
let state: State = { phase: 'idle', routes: {}, phases: {}, entries: [], calls: { anon: 0, direct: 0, wallet: 0 }, bytes: { anon: 0, direct: 0, wallet: 0 }, logs: [] }
const listeners = new Set<() => void>()
let nextId = 1

function setState(patch: Partial<State>) {
  state = { ...state, ...patch }
  for (const l of listeners) l()
}

export function useReads(): State {
  const [s, set] = useState(state)
  useEffect(() => {
    const l = () => set(state)
    listeners.add(l)
    l()
    return () => void listeners.delete(l)
  }, [])
  return s
}

function record(entry: Omit<Entry, 'id' | 'at'>): Entry {
  const e: Entry = { ...entry, id: nextId++, at: Date.now() }
  const calls = { ...state.calls, [e.route]: state.calls[e.route] + e.methods.length }
  setState({ entries: [e, ...state.entries].slice(0, MAX_ENTRIES), calls })
  return e
}

function finish(e: Entry, patch: Partial<Entry>) {
  Object.assign(e, patch)
  const bytes = { ...state.bytes, [e.route]: state.bytes[e.route] + (patch.bytes ?? 0) }
  setState({ entries: [...state.entries], bytes })
}

function methodsOf(body: unknown): string[] {
  try {
    const json = JSON.parse(String(body))
    return (Array.isArray(json) ? json : [json]).map((r: { method?: string }) => r.method ?? '?')
  } catch {
    return ['?']
  }
}

/** Wraps a fetch so each JSON-RPC request (or batch) lands in the traffic log. */
function logged(fetchFn: typeof fetch, route: Route, via: string, anonymous: boolean): typeof fetch {
  return async (url, init) => {
    const e = record({ route, via, methods: methodsOf(init?.body), anonymous })
    const t0 = performance.now()
    try {
      const res = await fetchFn(url, init)
      const body = await res.arrayBuffer()
      finish(e, { ms: performance.now() - t0, bytes: body.byteLength })
      return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers })
    } catch (err) {
      finish(e, { ms: performance.now() - t0, error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }
}

/** The connected wallet, with every request the app makes to it logged (signing, account, chain). */
export function loggedWallet(provider: EIP1193Provider, name: string): EIP1193Provider {
  const request = (async (args: { method: string; params?: unknown }) => {
    const e = record({ route: 'wallet', via: name, methods: [args.method], anonymous: false })
    const t0 = performance.now()
    try {
      const result = await provider.request(args as never)
      finish(e, { ms: performance.now() - t0 })
      return result
    } catch (err) {
      finish(e, { ms: performance.now() - t0, error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  }) as EIP1193Provider['request']
  return new Proxy(provider, { get: (target, key) => (key === 'request' ? request : Reflect.get(target, key)) })
}

// ------------------------------------------------------------------ settings + worker

const settingsKey = (chainId: number) => `navik:reads:${chainId}`

export function settingsFor(chainId: number): ReadSettings {
  const saved = store.get<ReadSettings | undefined>(settingsKey(chainId), undefined)
  const valid =
    saved &&
    (saved.network === 'direct' || networkById(saved.network)) &&
    !UNSUPPORTED[chainId]?.[saved.network] &&
    /^https?:\/\//.test(saved.rpc)
  return valid ? saved : defaultSettings(chainId)
}

export function saveSettings(chainId: number, settings: ReadSettings) {
  store.set(settingsKey(chainId), settings)
  route(chainId, true)
}

const workers = new Map<AnonNetwork['id'], AnonRpcWorker>()

/** Answers the harness's specifier read from the pinned values: no chain read before anonymity. */
function pinnedSpecifier(n: AnonNetwork) {
  const answers = pinnedAnswers(n)
  return {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      const answer = answers[(params?.[0] as { data?: string } | undefined)?.data?.slice(0, 10) ?? '']
      if (method === 'eth_call' && answer) return answer
      throw new Error(`pinned specifier: unexpected ${method}`)
    },
  }
}

/** Main chain's phase mirrors its network's, for the header and the viewer. */
function setPhase(id: AnonNetwork['id'], phase: Phase, error?: string) {
  const phases = { ...state.phases, [id]: { phase, error } }
  const main = state.settings?.network === id ? { phase, error } : {}
  setState({ phases, ...main })
}

function startWorker(n: AnonNetwork): AnonRpcWorker {
  const running = workers.get(n.id)
  if (running) return running
  const instance = new AnonRpcWorker({ address: n.specifier, config: n.config, preExisting: { rpcProvider: pinnedSpecifier(n) } })
  workers.set(n.id, instance)
  setPhase(n.id, 'connecting')
  instance.ready.then(
    () => workers.get(n.id) === instance && setPhase(n.id, 'ready'),
    (err: unknown) => workers.get(n.id) === instance && setPhase(n.id, 'failed', err instanceof Error ? err.message : String(err)),
  )
  void (async () => {
    for (;;) {
      const log = await instance.acceptLog().catch(() => undefined)
      if (!log || workers.get(n.id) !== instance) return
      const line = `${n.name}: ${log.level} ${log.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
      setState({ logs: [...state.logs, line].slice(-200) })
    }
  })()
  return instance
}

/** Closes workers no chain is routed through anymore. */
function stopUnused() {
  const used = new Set(Object.values(state.routes).map((r) => r.network))
  for (const [id, instance] of workers) {
    if (used.has(id)) continue
    instance.close()
    workers.delete(id)
    const { [id]: _, ...phases } = state.phases
    setState({ phases })
  }
}

/** Routes a chain's reads per its settings: starts the worker it needs. `main` marks the managed chain. */
function route(chainId: number, reload = false): ReadSettings {
  if (!reload && state.routes[chainId]) return state.routes[chainId]
  const settings = settingsFor(chainId)
  setState({ routes: { ...state.routes, [chainId]: settings } })
  stopUnused()
  const n = settings.network === 'direct' ? undefined : networkById(settings.network)
  if (n) startWorker(n)
  if (chainId === state.chainId) {
    const p = n ? state.phases[n.id] : undefined
    setState({ settings, phase: p?.phase ?? 'idle', error: p?.error })
  }
  return settings
}

/** Makes `chainId` the managed chain (its reads drive the header and the viewer). */
function activate(chainId: number): ReadSettings {
  setState({ chainId })
  return route(chainId, true)
}

/** Restarts failed workers. */
export function reconnect() {
  for (const [id, instance] of workers) {
    if (state.phases[id]?.phase !== 'failed') continue
    instance.close()
    workers.delete(id)
  }
  for (const chainId of Object.keys(state.routes)) route(Number(chainId), true)
}

/**
 * The read transport for a chain. `isolationKey` asks the network to keep reads under different
 * keys unlinkable (the dashboard and each viewed site get their own); support is per network.
 */
export function readTransport(chainId: number, isolationKey?: string): Transport {
  const settings =
    state.chainId === chainId && state.settings
      ? state.settings
      : chainId === ARKIV_CHAIN_ID
        ? route(chainId)
        : activate(chainId)
  const host = new URL(settings.rpc).host
  // mixnet round trips are slow: batch reads into one request, and allow for the first connection
  const opts = ANON_TRANSPORT
  const n = settings.network === 'direct' ? undefined : networkById(settings.network)
  if (!n) return http(settings.rpc, { ...opts, fetchFn: logged(fetch, 'direct', host, false) })
  const instance = startWorker(n)
  const anonFetch: typeof fetch = (url, init) =>
    instance.fetch(url, isolationKey ? { ...init, anonOptions: { isolationKey } } : init)
  return http(settings.rpc, { ...opts, fetchFn: logged(anonFetch, 'anon', `${n.name} → ${host}`, n.anonymous) })
}
