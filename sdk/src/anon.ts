import { type Address, encodeAbiParameters, type Hex, toFunctionSelector } from 'viem'

/**
 * The anon-rpc networks Navik reads through. The worker code is pinned here, at build time, rather
 * than read live from each network's specifier contract: a given dashboard or CLI version always
 * runs the exact anonymizer code it shipped with (keccak-checked by the harness before it runs),
 * and no un-anonymized bootstrap read is ever made.
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

/** Arkiv's testnet (Rabdi): release provenance and attestations are read from it. */
export const ARKIV_CHAIN_ID = 7794095
/**
 * The public endpoint (rate limited). An access key would make the build depend on it, so it is
 * left out; paste `<rpc>/<access key>` in the privacy panel to use one.
 */
const ARKIV_RPC = 'https://rpc.rabdi.db-chain.testnet.arkiv.network'

/** Public RPCs that accept anonymized traffic (CORS-open, no API key, accept JSON-RPC batches). */
export const PUBLIC_RPCS: Record<number, string[]> = {
  1: ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://1rpc.io/eth'],
  31337: ['http://127.0.0.1:8545'],
  [ARKIV_CHAIN_ID]: [ARKIV_RPC],
}

/**
 * Networks that cannot carry a chain's reads. Nym's worker drops the Content-Type header, which
 * Arkiv's node requires (it answers 415); Nox tunnels TLS end to end and keeps every header.
 */
export const UNSUPPORTED: Record<number, Partial<Record<NetworkId, string>>> = {
  [ARKIV_CHAIN_ID]: { nym: "drops the Content-Type header, which Arkiv's RPC requires" },
}

/**
 * Mainnet: Nym to a public RPC. Arkiv: Nox (see UNSUPPORTED). The local fork: no mixnet exit can
 * reach localhost, so passthrough.
 */
export function defaultSettings(chainId: number): ReadSettings {
  if (chainId === 1) return { network: 'nym', rpc: PUBLIC_RPCS[1][0] }
  if (chainId === ARKIV_CHAIN_ID) return { network: 'nox', rpc: ARKIV_RPC }
  return { network: 'passthrough', rpc: PUBLIC_RPCS[chainId]?.[0] ?? 'http://127.0.0.1:8545' }
}

export const networkById = (id: NetworkId) => NETWORKS.find((n) => n.id === id)

/** viem `http()` options: mixnet round trips are slow, so batch reads and allow for the first connection. */
export const ANON_TRANSPORT = { batch: { batchSize: 16, wait: 16 }, timeout: 120_000, retryCount: 1 }

const SEL_HASH = toFunctionSelector('workerHash()')
const SEL_RESOLVERS = toFunctionSelector('workerResolvers()')

/** What a network's specifier contract would answer, by selector: the harness reads these first. */
export const pinnedAnswers = (n: AnonNetwork): Record<string, Hex> => ({
  [SEL_HASH]: n.workerHash,
  [SEL_RESOLVERS]: encodeAbiParameters([{ type: 'string[]' }], [n.resolvers]),
})
