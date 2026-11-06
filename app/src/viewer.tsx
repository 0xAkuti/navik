import * as navik from '@navik/sdk'
import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

import { networkById, useReads } from './reads.ts'
import { type Compared, SourcePanel, type Wallet } from './source.tsx'
import { Addr, Badge, Hash, Icon, Info, kb, Mono, Spinner } from './ui.tsx'

type Loaded = { v: navik.Verification; ms: number; calls: number; bytes: number }

/**
 * Opens any ENS name with an ERC-8244 `contentcontract` record: resolves it through ENSv2's
 * UniversalResolver, reads the bytes from Ethereum (through the anon-rpc network), checks them,
 * and renders the site in a sandboxed frame. No gateway, no server, no wallet needed.
 */
export function Viewer(props: { ctx: navik.Ctx; name: string; wallet?: Wallet }) {
  const { ctx, name, wallet } = props
  const reads = useReads()
  const [input, setInput] = useState(name)
  const [progress, setProgress] = useState<{ step: string; done?: number; total?: number }>()
  const [loaded, setLoaded] = useState<Loaded>()
  const [error, setError] = useState<string>()
  const [compared, setCompared] = useState<Compared>()
  const counters = useRef(reads)
  counters.current = reads

  useEffect(() => {
    setInput(name)
    setLoaded(undefined)
    setError(undefined)
    setCompared(undefined)
    if (!name) return
    let cancelled = false
    const before = counters.current
    const t0 = performance.now()
    setProgress({ step: 'Resolving' })
    navik
      .verify(ctx, name, { onProgress: (done, total) => !cancelled && setProgress({ step: 'Reading from Ethereum', done, total }) })
      .then((v) => {
        if (cancelled) return
        const after = counters.current
        setLoaded({
          v,
          ms: performance.now() - t0,
          calls: after.calls.anon + after.calls.direct - (before.calls.anon + before.calls.direct),
          bytes: after.bytes.anon + after.bytes.direct - (before.bytes.anon + before.bytes.direct),
        })
      })
      .catch((err) => !cancelled && setError(navik.describeError(err)))
      .finally(() => !cancelled && setProgress(undefined))
    return () => {
      cancelled = true
    }
  }, [ctx, name])

  const ok = !!loaded && loaded.v.hashMatches && loaded.v.belongsToProject !== false
  const net = reads.settings && networkById(reads.settings.network)
  const pct = progress?.total ? Math.max(8, (100 * (progress.done ?? 0)) / progress.total) : progress ? 8 : 0

  return (
    <div class="page viewer">
      <form
        class={`urlbar ${ok ? 'ok' : error || (loaded && !ok) ? 'bad' : ''}`}
        onSubmit={(e) => {
          e.preventDefault()
          if (input) location.hash = `#/open/${input}`
        }}
      >
        <span class="urlbar-icon" title={ok ? 'Verified onchain' : undefined}>
          {progress ? <Spinner /> : <Icon name={ok ? 'shield' : 'search'} />}
        </span>
        <input
          placeholder={`portfolio.${ctx.deployment.root}`}
          value={input}
          onInput={(e) => setInput((e.currentTarget as HTMLInputElement).value.trim().toLowerCase())}
          aria-label="Name to open"
        />
        <button class="btn primary sm" disabled={!input}>
          Open
        </button>
        {progress && <span class="urlbar-progress" style={{ width: `${pct}%` }} />}
      </form>

      {!name && (
        <div class="empty">
          <span class="feature-icon">
            <Icon name="globe" size={20} />
          </span>
          <h2>
            Open any onchain site{' '}
            <Info>
              Any ENS name with an ERC-8244 <Mono>contentcontract</Mono> record, read from Ethereum, checked and sandboxed.
            </Info>
          </h2>
          <a class="btn" href={`#/open/${ctx.deployment.root}`}>
            Try {ctx.deployment.root}
          </a>
        </div>
      )}

      {progress && (
        <p class="muted small center">
          {progress.step}
          {progress.total ? ` · chunk ${progress.done}/${progress.total}` : '…'}
          {reads.phase === 'connecting' && net ? ` · connecting to ${net.name} first` : ''}
        </p>
      )}
      {error && (
        <div class="card error-card">
          <Icon name="x" /> {error}
        </div>
      )}

      {loaded && (
        <div class="viewer-grid">
          {ok ? <SiteFrame v={loaded.v} /> : <div class="card error-card">This site failed verification and is not rendered.</div>}
          <div class="side">
            <aside class="card verify">
              <div class="row">
                <h3>Verification</h3>
                <span class="spacer" />
                <Badge tone={ok ? 'ok' : 'warn'}>{ok ? 'verified' : 'check failed'}</Badge>
              </div>
              <ul class="checks">
                <Check ok>
                  Resolves to <Addr address={loaded.v.deployment} chainId={ctx.deployment.chainId} />
                </Check>
                {loaded.v.isNavikDeployment ? (
                  <Check ok>
                    Navik release{loaded.v.releaseName && <> <Mono>{loaded.v.releaseName}</Mono></>}
                  </Check>
                ) : (
                  <Check>Not a Navik release</Check>
                )}
                {loaded.v.belongsToProject !== undefined && (
                  <Check ok={loaded.v.belongsToProject}>
                    {loaded.v.belongsToProject ? 'Belongs to the project' : 'Does not belong to the project'}
                  </Check>
                )}
                {loaded.v.isNavikDeployment && (
                  <Check ok={loaded.v.hashMatches}>
                    {loaded.v.hashMatches ? 'Content hash matches' : 'Content hash does NOT match'}
                  </Check>
                )}
                {loaded.v.original && <Check ok>Gzipped, {kb(loaded.v.original.html.length)} unpacked</Check>}
              </ul>
              <dl class="facts">
                <dt>Size</dt>
                <dd>{kb(loaded.v.html.length)}</dd>
                <dt>keccak256</dt>
                <dd>
                  <Hash value={loaded.v.computedHash} chars={14} />
                </dd>
                <dt>Read</dt>
                <dd title={`${loaded.calls} calls, ${kb(loaded.bytes)}`}>
                  {(loaded.ms / 1000).toFixed(1)} s{net && <> via {net.name}</>}
                </dd>
              </dl>
              <CompareBuild v={loaded.v} result={compared} onResult={setCompared} />
            </aside>
            {ok && <SourcePanel ctx={ctx} v={loaded.v} isolationKey={`site:${name}`} wallet={wallet} compared={compared} />}
          </div>
        </div>
      )}
    </div>
  )
}

function Check(props: { ok?: boolean; children: ComponentChildren }) {
  return (
    <li class={props.ok === undefined ? 'muted' : props.ok ? '' : 'error'}>
      <Icon name={props.ok === false ? 'x' : props.ok ? 'check' : 'chevron'} size={14} />
      <span>{props.children}</span>
    </li>
  )
}

/** Drop a local build to check it is byte-identical to what is onchain (e.g. built from the repo). */
function CompareBuild(props: { v: navik.Verification; result?: Compared; onResult: (r: Compared) => void }) {
  const { result, onResult: setResult } = props
  return (
    <div class="compare">
      <label class="drop small">
        <input
          type="file"
          onChange={async (e) => {
            const f = (e.currentTarget as HTMLInputElement).files?.[0]
            if (f) setResult({ file: f.name, cmp: navik.compareBuild(props.v, new Uint8Array(await f.arrayBuffer())) })
          }}
        />
        <Icon name="upload" size={14} /> Compare with a local build
      </label>
      {result &&
        (result.cmp.matches ? (
          <p class="ok-text small">
            <Icon name="check" size={14} /> {result.file} is byte-identical to the{' '}
            {result.cmp.matched === 'original' ? 'original document' : 'release'}
          </p>
        ) : (
          <p class="error small">
            <Icon name="x" size={14} /> {result.file} differs (keccak256 <Hash value={result.cmp.hash} chars={14} />)
          </p>
        ))}
    </div>
  )
}

/**
 * The site runs in an opaque origin (no allow-same-origin): it cannot read this app's storage or
 * reach its wallet connection.
 */
function SiteFrame(props: { v: navik.Verification }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const html = new TextDecoder().decode(props.v.original?.html ?? props.v.html)
  return (
    <div class="site">
      <div class="site-bar">
        <span class="muted small">Sandboxed</span>
        <Info>The site cannot reach this page or your wallet.</Info>
        <span class="spacer" />
        <button class="btn ghost sm" onClick={() => frame.current?.requestFullscreen?.()}>
          Full screen
        </button>
      </div>
      <iframe ref={frame} class="site-frame" title={props.v.name} sandbox="allow-scripts allow-forms allow-popups allow-modals" srcdoc={html} />
    </div>
  )
}
