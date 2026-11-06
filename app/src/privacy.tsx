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
import { Badge, Info, kb } from './ui.tsx'

/** Header pill: where reads go right now, and how many reads went through anon-rpc. */
export function PrivacyPill(props: { open: boolean; onToggle: () => void }) {
  const r = useReads()
  if (!r.settings) return null
  const n = networkById(r.settings.network)
  // wallet requests (account, chain, signing) are not reads, so they are not counted here
  const reads = r.calls.anon + r.calls.direct
  const tone = !n || !n.anonymous ? 'warn' : r.phase === 'failed' ? 'error' : r.phase === 'ready' ? 'ok' : 'muted'
  const label = !n
    ? 'Direct reads'
    : !n.anonymous
      ? `${n.name}: not anonymous`
      : r.phase === 'failed'
        ? `${n.name} unreachable`
        : r.phase === 'ready'
          ? `Private via ${n.name}`
          : `Connecting to ${n.name}…`
  return (
    <button class={`pill ${tone}`} onClick={props.onToggle} aria-expanded={props.open} title="Reads and privacy">
      <i class={`dot ${tone}`} />
      <span class="pill-label">{label}</span>
      {reads > 0 && (
        <span class="pill-count" title={`${r.calls.anon} of ${reads} reads via anon-rpc`}>
          {r.calls.anon}/{reads}
        </span>
      )}
    </button>
  )
}

/** Bottom drawer: choose the network and RPC, and watch every request the app makes. */
export function PrivacyDrawer(props: { onClose: () => void }) {
  const r = useReads()
  const chainId = r.chainId
  const [showLog, setShowLog] = useState(false)
  if (chainId === undefined || !r.settings) return null

  const reads = r.calls.anon + r.calls.direct
  const pct = reads ? Math.round((100 * r.calls.anon) / reads) : 100

  return (
    <section class="drawer" aria-label="Network privacy">
      <header>
        <h2>
          Reads{' '}
          <Info>
            Reads go through anon-rpc: the RPC sees a mixnet exit, not your IP. Your wallet only signs. If the network is down, reads stop;
            nothing falls back to a direct connection.
          </Info>
        </h2>
        <button class="btn ghost sm" onClick={props.onClose}>
          Close
        </button>
      </header>
      <div class="drawer-body">
        <div class="drawer-settings">
          <div class="meter">
            <strong>{pct}%</strong> of {reads} reads through anon-rpc
            <div class="meter-bar">
              <span style={{ width: `${pct}%` }} />
            </div>
            <p class="small muted" title={`${kb(r.bytes.anon)} via anon-rpc, ${kb(r.bytes.direct)} direct`}>
              {r.calls.anon} via anon-rpc · {r.calls.direct} direct · {r.calls.wallet} wallet
            </p>
          </div>

          <RouteSettings chainId={chainId} title="Ethereum reads" settings={r.settings} />
          <RouteSettings
            chainId={ARKIV_CHAIN_ID}
            title="Arkiv reads"
            settings={r.routes[ARKIV_CHAIN_ID] ?? settingsFor(ARKIV_CHAIN_ID)}
          />
        </div>

        <div class="drawer-traffic">
          <div class="row">
            <h2>Requests</h2>
            <span class="spacer" />
            <button class="btn ghost sm" onClick={() => setShowLog(!showLog)}>
              {showLog ? 'Show requests' : `Network log (${r.logs.length})`}
            </button>
          </div>
          {showLog ? (
            <pre class="netlog">{r.logs.join('\n') || 'No log lines yet.'}</pre>
          ) : r.entries.length === 0 ? (
            <p class="muted small">No requests yet.</p>
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
      </div>
    </section>
  )
}

/** Network and RPC for one chain's reads: the managed chain, or Arkiv. */
function RouteSettings(props: { chainId: number; title: string; settings: ReadSettings }) {
  const r = useReads()
  const [network, setNetwork] = useState<NetworkId>(props.settings.network)
  const [rpc, setRpc] = useState(props.settings.rpc)
  useEffect(() => {
    setNetwork(props.settings.network)
    setRpc(props.settings.rpc)
  }, [props.settings.network, props.settings.rpc])

  const validRpc = /^https?:\/\/[^\s]+$/.test(rpc)
  const dirty = network !== props.settings.network || rpc !== props.settings.rpc
  const id = props.settings.network === 'direct' ? undefined : props.settings.network
  const failed = id && r.phases[id]?.phase === 'failed' ? (r.phases[id]?.error ?? 'unreachable') : undefined
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (validRpc) saveSettings(props.chainId, { network, rpc })
      }}
    >
      <fieldset>
        <legend>{props.title}</legend>
        {NETWORKS.map((net) => {
          const unsupported = UNSUPPORTED[props.chainId]?.[net.id]
          return (
            <label key={net.id} class={`radio ${unsupported ? 'disabled' : ''}`}>
              <input
                type="radio"
                name={`network-${props.chainId}`}
                checked={network === net.id}
                disabled={!!unsupported}
                onChange={() => setNetwork(net.id)}
              />
              <span>{net.name}</span>
              <Info>{unsupported ?? net.tagline}</Info>
            </label>
          )
        })}
        <label class="radio">
          <input type="radio" name={`network-${props.chainId}`} checked={network === 'direct'} onChange={() => setNetwork('direct')} />
          <span>Direct</span>
          <Info>Straight to the RPC, which sees your IP with every read.</Info>
        </label>
      </fieldset>
      <input id={`read-rpc-${props.chainId}`} aria-label="RPC endpoint" list={`read-rpcs-${props.chainId}`} value={rpc} onInput={(e) => setRpc((e.currentTarget as HTMLInputElement).value.trim())} />
      <datalist id={`read-rpcs-${props.chainId}`}>
        {(PUBLIC_RPCS[props.chainId] ?? []).map((u) => (
          <option key={u} value={u} />
        ))}
      </datalist>
      <div class="row">
        <button class="btn primary sm" disabled={!dirty || !validRpc}>
          Apply
        </button>
        {failed && (
          <button class="btn sm" type="button" onClick={reconnect}>
            Reconnect
          </button>
        )}
      </div>
      {failed && <p class="error small">{failed}</p>}
    </form>
  )
}

function TrafficRow({ e }: { e: Entry }) {
  const tone = e.route === 'wallet' ? 'muted' : e.anonymous ? 'ok' : 'warn'
  const label = e.route === 'wallet' ? 'wallet' : e.route === 'direct' ? 'direct' : e.anonymous ? 'anon-rpc' : 'anon-rpc*'
  const methods = summarize(e.methods)
  return (
    <tr class={e.error ? 'failed' : ''}>
      <td>
        <Badge tone={tone}>{label}</Badge>
      </td>
      <td class="mono small" title={e.methods.join(', ')}>
        {methods}
      </td>
      <td class="small muted">{e.via}</td>
      <td class="small muted num">
        {e.error ? <span class="error" title={e.error}>failed</span> : e.ms === undefined ? '…' : `${Math.round(e.ms)} ms`}
      </td>
      <td class="small muted num">{e.bytes !== undefined ? kb(e.bytes) : ''}</td>
    </tr>
  )
}

/** `eth_call ×12, eth_blockNumber` */
function summarize(methods: string[]): string {
  const counts = new Map<string, number>()
  for (const m of methods) counts.set(m, (counts.get(m) ?? 0) + 1)
  return [...counts].map(([m, c]) => (c > 1 ? `${m} ×${c}` : m)).join(', ')
}
