import { useEffect, useState } from 'preact/hooks'

import {
  ARKIV_CHAIN_ID,
  type Entry,
  NETWORKS,
  type NetworkId,
  networkById,
  PUBLIC_RPCS,
  type ReadSettings,
  reconnect,
  saveSettings,
  settingsFor,
  UNSUPPORTED,
  useReads,
} from './reads.ts'
import { Icon, Info, kb } from './ui.tsx'

/** Where the main chain's reads go right now, in a word or two. */
function status(r: ReturnType<typeof useReads>) {
  const n = r.settings && networkById(r.settings.network)
  if (!n) return { tone: 'warn', label: 'Direct reads' }
  if (!n.anonymous) return { tone: 'warn', label: 'Not anonymous' }
  if (r.phase === 'failed') return { tone: 'error', label: `${n.name} unreachable` }
  if (r.phase === 'ready') return { tone: 'ok', label: `Private via ${n.name}` }
  return { tone: 'muted', label: 'Connecting…' }
}

/** Header pill: the state of reads at a glance; opens the panel. */
export function PrivacyPill(props: { open: boolean; onToggle: () => void }) {
  const r = useReads()
  if (!r.settings) return null
  const { tone, label } = status(r)
  return (
    <button class={`pill ${tone}`} onClick={props.onToggle} aria-expanded={props.open} title="Reads and privacy">
      <i class={`dot ${tone}`} />
      {label}
    </button>
  )
}

/** Floating panel: choose each route, and watch every request the app makes. */
export function PrivacyPanel(props: { onClose: () => void }) {
  const r = useReads()
  const chainId = r.chainId
  const [showLog, setShowLog] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])
  if (chainId === undefined || !r.settings) return null

  const { tone, label } = status(r)
  const arkiv = r.routes[ARKIV_CHAIN_ID] ?? settingsFor(ARKIV_CHAIN_ID)

  return (
    <section class="drawer" aria-label="Network privacy">
      <header>
        <h2>
          <i class={`dot ${tone}`} />
          {label}{' '}
          <Info>The RPC sees a mixnet exit, not your IP. Your wallet only signs. If the network is down, reads stop.</Info>
        </h2>
        <button class="icon-btn" onClick={props.onClose} aria-label="Close">
          <Icon name="x" />
        </button>
      </header>

      <dl class="stats">
        <div title={kb(r.bytes.anon)}>
          <dt>anon-rpc</dt>
          <dd>{r.calls.anon}</dd>
        </div>
        <div title={kb(r.bytes.direct)} class={r.calls.direct ? 'warn' : ''}>
          <dt>direct</dt>
          <dd>{r.calls.direct}</dd>
        </div>
        <div title="Account, chain and signing: not reads">
          <dt>wallet</dt>
          <dd>{r.calls.wallet}</dd>
        </div>
      </dl>

      <div class="routes">
        <Route chainId={chainId} title="Ethereum reads" settings={r.settings} />
        <Route chainId={ARKIV_CHAIN_ID} title="Arkiv reads" settings={arkiv} />
      </div>

      <details class="rpcs">
        <summary>
          <Icon name="chevron" size={14} /> RPC endpoints
        </summary>
        <RpcField chainId={chainId} title="Ethereum" settings={r.settings} />
        <RpcField chainId={ARKIV_CHAIN_ID} title="Arkiv" settings={arkiv} />
      </details>

      <div class="traffic-head">
        <h3>{showLog ? 'Network log' : 'Requests'}</h3>
        <button class="btn ghost sm" onClick={() => setShowLog(!showLog)}>
          {showLog ? 'Requests' : 'Log'}
        </button>
      </div>
      <div class="traffic-body">
        {showLog ? (
          <pre class="netlog">{r.logs.join('\n') || 'Empty.'}</pre>
        ) : r.entries.length === 0 ? (
          <p class="muted small">None yet.</p>
        ) : (
          <table class="traffic">
            <tbody>
              {r.entries.map((e) => (
                <TrafficRow key={e.id} e={e} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  )
}

/** The network one chain's reads go through. Applies on change. */
function Route(props: { chainId: number; title: string; settings: ReadSettings }) {
  const r = useReads()
  const { chainId, title, settings } = props
  const n = networkById(settings.network)
  const phase = n && r.phases[n.id]
  return (
    <>
      <label class="route">
        <span>{title}</span>
        <Info>{n?.tagline ?? 'Straight to the RPC, which sees your IP with every read.'}</Info>
        <select
          value={settings.network}
          onChange={(e) => saveSettings(chainId, { ...settings, network: (e.currentTarget as HTMLSelectElement).value as NetworkId })}
        >
          {NETWORKS.map((net) => (
            <option key={net.id} value={net.id} disabled={!!UNSUPPORTED[chainId]?.[net.id]} title={UNSUPPORTED[chainId]?.[net.id]}>
              {net.name}
              {net.anonymous ? '' : ' (exposes IP)'}
            </option>
          ))}
          <option value="direct">Direct (exposes IP)</option>
        </select>
      </label>
      {phase?.phase === 'failed' && (
        <p class="route-failed small">
          <span class="error">
            Unreachable {phase.error && <Info>{phase.error}</Info>}
          </span>
          <button class="btn sm" onClick={reconnect}>
            Reconnect
          </button>
        </p>
      )}
    </>
  )
}

/** The RPC behind a route. Applies when the field is left or on Enter. */
function RpcField(props: { chainId: number; title: string; settings: ReadSettings }) {
  const { chainId, title, settings } = props
  const [rpc, setRpc] = useState(settings.rpc)
  useEffect(() => setRpc(settings.rpc), [settings.rpc])
  const valid = /^https?:\/\/[^\s]+$/.test(rpc)
  return (
    <label class="rpc">
      <span class="small muted">{title}</span>
      <input
        value={rpc}
        list={`read-rpcs-${chainId}`}
        aria-invalid={!valid}
        onInput={(e) => setRpc((e.currentTarget as HTMLInputElement).value.trim())}
        onChange={() => valid && rpc !== settings.rpc && saveSettings(chainId, { ...settings, rpc })}
        onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()}
      />
      <datalist id={`read-rpcs-${chainId}`}>
        {(PUBLIC_RPCS[chainId] ?? []).map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
    </label>
  )
}

function TrafficRow({ e }: { e: Entry }) {
  const tone = e.route === 'wallet' ? '' : e.anonymous ? 'ok' : 'warn'
  const route = e.route === 'wallet' ? 'wallet' : e.route === 'direct' ? 'direct' : 'anon-rpc'
  return (
    <tr class={e.error ? 'failed' : ''} title={[route, e.via, e.bytes === undefined ? '' : kb(e.bytes), e.error].filter(Boolean).join(' · ')}>
      <td>
        <i class={`dot ${tone}`} />
      </td>
      <td class="mono">{summarize(e.methods)}</td>
      <td class="muted">{e.via.split(' → ')[0]}</td>
      <td class="muted num">{e.error ? <span class="error">failed</span> : e.ms === undefined ? '…' : `${Math.round(e.ms)} ms`}</td>
    </tr>
  )
}

/** `eth_call ×12, eth_blockNumber` */
function summarize(methods: string[]): string {
  const counts = new Map<string, number>()
  for (const m of methods) counts.set(m, (counts.get(m) ?? 0) + 1)
  return [...counts].map(([m, c]) => (c > 1 ? `${m} ×${c}` : m)).join(', ')
}
