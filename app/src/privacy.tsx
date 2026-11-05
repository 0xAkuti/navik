import { useEffect, useState } from 'preact/hooks'

import {
  type Entry,
  NETWORKS,
  type NetworkId,
  networkById,
  PUBLIC_RPCS,
  reconnect,
  saveSettings,
  useReads,
} from './reads.ts'
import { Badge, kb } from './ui.tsx'

/** Header pill: where reads go right now, and how many calls stayed private. */
export function PrivacyPill(props: { open: boolean; onToggle: () => void }) {
  const r = useReads()
  if (!r.settings) return null
  const n = networkById(r.settings.network)
  const total = r.calls.anon + r.calls.direct + r.calls.wallet
  const tone = !n || !n.anonymous ? 'warn' : r.phase === 'failed' ? 'error' : r.phase === 'ready' ? 'ok' : 'muted'
  const label = !n
    ? 'Direct reads: the RPC sees your IP'
    : !n.anonymous
      ? `${n.name}: not anonymous`
      : r.phase === 'failed'
        ? `${n.name} unreachable: reads paused`
        : r.phase === 'ready'
          ? `Private reads via ${n.name}`
          : `Connecting to ${n.name}…`
  return (
    <button class={`pill ${tone}`} onClick={props.onToggle} aria-expanded={props.open} title="How this app reads Ethereum">
      <span class={`dot ${tone}`} />
      {label}
      {total > 0 && (
        <span class="pill-count">
          {r.calls.anon}/{total} via anon-rpc
        </span>
      )}
    </button>
  )
}

/** Bottom drawer: choose the network and RPC, and watch every request the app makes. */
export function PrivacyDrawer(props: { onClose: () => void }) {
  const r = useReads()
  const chainId = r.chainId
  const [network, setNetwork] = useState<NetworkId>(r.settings?.network ?? 'nym')
  const [rpc, setRpc] = useState(r.settings?.rpc ?? '')
  const [showLog, setShowLog] = useState(false)
  useEffect(() => {
    if (r.settings) {
      setNetwork(r.settings.network)
      setRpc(r.settings.rpc)
    }
  }, [r.settings])
  if (chainId === undefined || !r.settings) return null

  const validRpc = /^https?:\/\/[^\s]+$/.test(rpc)
  const dirty = network !== r.settings.network || rpc !== r.settings.rpc
  const n = networkById(r.settings.network)
  const total = r.calls.anon + r.calls.direct + r.calls.wallet
  const pct = total ? Math.round((100 * r.calls.anon) / total) : 100

  return (
    <section class="drawer" aria-label="Network privacy">
      <header>
        <h2>How this app reads Ethereum</h2>
        <button class="ghost" onClick={props.onClose}>
          Close
        </button>
      </header>
      <div class="drawer-body">
        <div class="drawer-settings">
          <div class="meter">
            <strong>{pct}%</strong> of {total} calls through anon-rpc
            {n && !n.anonymous && <Badge tone="warn">{n.name} does not anonymize</Badge>}
            <div class="meter-bar">
              <span style={{ width: `${pct}%` }} />
            </div>
            <p class="small muted">
              {r.calls.anon} via anon-rpc ({kb(r.bytes.anon)}) · {r.calls.direct} direct ({kb(r.bytes.direct)}) ·{' '}
              {r.calls.wallet} to your wallet (accounts, chain, signing)
            </p>
            <p class="small muted">
              Names, projects, releases and site bytes are read through the anon-rpc network: the RPC provider sees a
              mixnet exit, not your IP. Only signing and broadcasting go to your wallet, and a broadcast transaction is
              public anyway. If the network is unreachable, reads stop; nothing falls back to a direct connection.
            </p>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (validRpc) saveSettings(chainId, { network, rpc })
            }}
          >
            <fieldset>
              <legend class="small muted">Route reads through</legend>
              {NETWORKS.map((net) => (
                <label key={net.id} class="radio">
                  <input type="radio" name="network" checked={network === net.id} onChange={() => setNetwork(net.id)} />
                  <span>
                    <strong>{net.name}</strong> {!net.anonymous && <Badge tone="warn">not anonymous</Badge>}
                    <span class="small muted"> {net.tagline}</span>
                  </span>
                </label>
              ))}
              <label class="radio">
                <input type="radio" name="network" checked={network === 'direct'} onChange={() => setNetwork('direct')} />
                <span>
                  <strong>Direct</strong> <Badge tone="warn">not anonymous</Badge>
                  <span class="small muted"> straight to the RPC, which sees your IP with every read</span>
                </span>
              </label>
            </fieldset>
            <label class="small muted" for="read-rpc">
              RPC endpoint (reached through the network above)
            </label>
            <input id="read-rpc" list="read-rpcs" value={rpc} onInput={(e) => setRpc((e.currentTarget as HTMLInputElement).value.trim())} />
            <datalist id="read-rpcs">
              {(PUBLIC_RPCS[chainId] ?? []).map((u) => (
                <option key={u} value={u} />
              ))}
            </datalist>
            <div class="row">
              <button class="primary" disabled={!dirty || !validRpc}>
                Apply
              </button>
              {r.phase === 'failed' && (
                <button type="button" onClick={reconnect}>
                  Reconnect
                </button>
              )}
            </div>
            {r.phase === 'failed' && <p class="error small">{r.error}</p>}
          </form>
        </div>

        <div class="drawer-traffic">
          <div class="row">
            <h2>Requests</h2>
            <span class="spacer" />
            <button class="ghost small" onClick={() => setShowLog(!showLog)}>
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
