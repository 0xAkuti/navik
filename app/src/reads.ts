import { AnonRpcWorker } from '@anon-rpc/browser-harness'
import { useEffect, useState } from 'preact/hooks'
import {
  type Address,
  type EIP1193Provider,
  encodeAbiParameters,
  type Hex,
  http,
  type Transport,
  toFunctionSelector,
} from 'viem'

import { store } from './store.ts'

/**
 * Every chain read goes through an anon-rpc network by default: the RPC provider sees a mixnet
 * exit, not the user's IP, so it cannot tie "who" to the names, projects and accounts being read.
 * Only signing and broadcasting go to the wallet (a broadcast transaction is public anyway).
 *
 * The worker code is pinned here, at build time, rather than read live from each network's
 * specifier contract: the app itself is an immutable onchain release, so pinning means a given
 * dashboard version always runs the exact anonymizer code it was published with (keccak-checked
 * by the harness before it runs), and no un-anonymized bootstrap read is ever made.
 * Refresh with: cast call <specifier> "workerHash()(bytes32)" / "workerResolvers()(string[])".
 */
export type AnonNetwork = {
  id: 'nym' | 'nox' | 'tor' | 'passthrough'
  name: string
  tagline: string
  /** false: a reference worker that demonstrates the sandbox but does not anonymize. */
  anonymous: boolean
  specifier: Address
  workerHash: Hex
  resolvers: string[]
  /** network-defined; Tor needs gateways */
  config: { gateways?: string[] }
}

export const NETWORKS: AnonNetwork[] = [
  {
    id: 'nym',
    name: 'Nym',
    tagline: 'Sphinx mixnet; the RPC sees a Nym exit router, not you. ~6 s to connect, then ~0.6 s per read',
    anonymous: true,
    specifier: '0x3aCD9742C68F6d993066Ae25533e09b9e1f60eD0',
    workerHash: '0xf13a448a8721b9d0b20da3d5b80ffe00bf4c5bb3aae812a38d3d1e3bc81fceb8',
    resolvers: [
      'https://cdn.jsdelivr.net/npm/@nymproject/anon-rpc-worker@0.1.0/dist/nym-anon-rpc-worker.js',
      'https://unpkg.com/@nymproject/anon-rpc-worker@0.1.0/dist/nym-anon-rpc-worker.js',
      'https://raw.githubusercontent.com/nymtech/anon-rpc-worker/keccak/f1/3a448a8721b9d0b20da3d5b80ffe00bf4c5bb3aae812a38d3d1e3bc81fceb8',
    ],
    config: {},
  },
  {
    id: 'nox',
    name: 'Nox',
    tagline: 'Sphinx mixnet with end-to-end TLS to the RPC; ~1.5 s to connect, ~1 s per read',
    anonymous: true,
    specifier: '0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A',
    workerHash: '0xd9fa04b080a33062680a27cad828196bfb04615a0ebc76bcbffedb6dcbe838d4',
    resolvers: [
      'https://raw.githubusercontent.com/hisoka-io/anon-rpc/keccak/d9/fa04b080a33062680a27cad828196bfb04615a0ebc76bcbffedb6dcbe838d4',
      'https://cdn.jsdelivr.net/npm/@hisoka-io/anon-rpc-worker@0.4.1/dist/anon-rpc-worker.js',
      'https://unpkg.com/@hisoka-io/anon-rpc-worker@0.4.1/dist/anon-rpc-worker.js',
    ],
    config: {},
  },
  {
    id: 'tor',
    name: 'Tor',
    tagline: 'Tor client in WebAssembly via a demo gateway that may be offline; slow first connection',
    anonymous: true,
    specifier: '0x700dA3193D35fA54Cd3fBf29B66f2a2A0385659e',
    workerHash: '0x5b62f358ce7a2b94ee9bc3a0e6a08757db68fa08fc348276f31eda788aec818b',
    resolvers: [
      'https://cdn.jsdelivr.net/npm/tor-js@0.4.4/dist/anon-rpc-worker.js',
      'https://unpkg.com/tor-js@0.4.4/dist/anon-rpc-worker.js',
      'https://raw.githubusercontent.com/ethereum/tor-js/keccak/5b/62f358ce7a2b94ee9bc3a0e6a08757db68fa08fc348276f31eda788aec818b',
    ],
    config: { gateways: ['152.236.3.22:12298:uEiCH0VdbhryzJcMtCfB0vLA4sOvHdQ4hq5w7CopcwU59bQ'] },
  },
  {
    id: 'passthrough',
    name: 'Passthrough',
    tagline: 'reference worker: runs sandboxed like the others but fetches directly. Not anonymous; for local testing',
    anonymous: false,
    specifier: '0x4fd77be300f31c5fe6ab266d35d27750a3478d27',
    workerHash: '0x194f04bde4925f6bbb0bd8bdfceca7251125eaa0664ce3c0c25dce2a1545338d',
    resolvers: [
      'https://raw.githubusercontent.com/privacy-ethereum/anon-rpc/keccak/19/4f04bde4925f6bbb0bd8bdfceca7251125eaa0664ce3c0c25dce2a1545338d',
    ],
    config: {},
  },
]

export type NetworkId = AnonNetwork['id'] | 'direct'
export type ReadSettings = { network: NetworkId; rpc: string }

/** Public RPCs that accept anonymized traffic (CORS-open, no API key, accept JSON-RPC batches). */
export const PUBLIC_RPCS: Record<number, string[]> = {
  1: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'],
  31337: ['http://127.0.0.1:8545'],
}

/** Mainnet: Nym to a public RPC. The local fork: no mixnet exit can reach localhost, so passthrough. */
export function defaultSettings(chainId: number): ReadSettings {
  return chainId === 1
    ? { network: 'nym', rpc: PUBLIC_RPCS[1][0] }
    : { network: 'passthrough', rpc: PUBLIC_RPCS[chainId]?.[0] ?? 'http://127.0.0.1:8545' }
}

export const networkById = (id: NetworkId) => NETWORKS.find((n) => n.id === id)

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
  chainId?: number
  settings?: ReadSettings
  phase: Phase
  error?: string
  entries: Entry[]
  /** individual JSON-RPC calls (a batch counts each call) and response bytes, by route */
  calls: Record<Route, number>
  bytes: Record<Route, number>
  logs: string[]
}

const MAX_ENTRIES = 300
let state: State = { phase: 'idle', entries: [], calls: { anon: 0, direct: 0, wallet: 0 }, bytes: { anon: 0, direct: 0, wallet: 0 }, logs: [] }
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
  const valid = saved && (saved.network === 'direct' || networkById(saved.network)) && /^https?:\/\//.test(saved.rpc)
  return valid ? saved : defaultSettings(chainId)
}

export function saveSettings(chainId: number, settings: ReadSettings) {
  store.set(settingsKey(chainId), settings)
  if (state.chainId === chainId) activate(chainId)
}

let worker: { network: AnonNetwork['id']; instance: AnonRpcWorker } | undefined

const SEL_HASH = toFunctionSelector('workerHash()')
const SEL_RESOLVERS = toFunctionSelector('workerResolvers()')

/** Answers the harness's specifier read from the pinned values: no chain read before anonymity. */
function pinnedSpecifier(n: AnonNetwork) {
  return {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      const selector = (params?.[0] as { data?: string } | undefined)?.data?.slice(0, 10)
      if (method === 'eth_call' && selector === SEL_HASH) return n.workerHash
      if (method === 'eth_call' && selector === SEL_RESOLVERS) return encodeAbiParameters([{ type: 'string[]' }], [n.resolvers])
      throw new Error(`pinned specifier: unexpected ${method}`)
    },
  }
}

function startWorker(n: AnonNetwork): AnonRpcWorker {
  if (worker?.network === n.id) return worker.instance
  worker?.instance.close()
  const instance = new AnonRpcWorker({ address: n.specifier, config: n.config, preExisting: { rpcProvider: pinnedSpecifier(n) } })
  worker = { network: n.id, instance }
  setState({ phase: 'connecting', error: undefined, logs: [] })
  instance.ready.then(
    () => worker?.instance === instance && setState({ phase: 'ready' }),
    (err: unknown) => worker?.instance === instance && setState({ phase: 'failed', error: err instanceof Error ? err.message : String(err) }),
  )
  void (async () => {
    for (;;) {
      const log = await instance.acceptLog().catch(() => undefined)
      if (!log || worker?.instance !== instance) return
      const line = `${log.level} ${log.args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`
      setState({ logs: [...state.logs, line].slice(-200) })
    }
  })()
  return instance
}

/** Makes `chainId`'s settings current: (re)starts the worker when the network changed. */
function activate(chainId: number): ReadSettings {
  const settings = settingsFor(chainId)
  const n = settings.network === 'direct' ? undefined : networkById(settings.network)
  if (n) startWorker(n)
  else {
    worker?.instance.close()
    worker = undefined
    setState({ phase: 'idle', error: undefined })
  }
  setState({ chainId, settings })
  return settings
}

/** Restarts a failed worker. */
export function reconnect() {
  worker?.instance.close()
  worker = undefined
  if (state.chainId !== undefined) activate(state.chainId)
}

/**
 * The read transport for a chain. `isolationKey` asks the network to keep reads under different
 * keys unlinkable (the dashboard and each viewed site get their own); support is per network.
 */
export function readTransport(chainId: number, isolationKey?: string): Transport {
  const settings = state.chainId === chainId && state.settings ? state.settings : activate(chainId)
  const host = new URL(settings.rpc).host
  // mixnet round trips are slow: batch reads into one request, and allow for the first connection
  const opts = { batch: { batchSize: 16, wait: 16 }, timeout: 120_000, retryCount: 1 }
  const n = settings.network === 'direct' ? undefined : networkById(settings.network)
  if (!n) return http(settings.rpc, { ...opts, fetchFn: logged(fetch, 'direct', host, false) })
  const instance = startWorker(n)
  const anonFetch: typeof fetch = (url, init) =>
    instance.fetch(url, isolationKey ? { ...init, anonOptions: { isolationKey } } : init)
  return http(settings.rpc, { ...opts, fetchFn: logged(anonFetch, 'anon', `${n.name} → ${host}`, n.anonymous) })
}
