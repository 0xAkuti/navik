import * as navik from '@navik/sdk'
import { useEffect, useRef, useState } from 'preact/hooks'

import { useReads } from './reads.ts'
import { Badge, Card, kb, Mono } from './ui.tsx'

type Loaded = { v: navik.Verification; ms: number; calls: number; bytes: number }

/**
 * Opens any ENS name with an ERC-8244 `contentcontract` record: resolves it through ENSv2's
 * UniversalResolver, reads the bytes from Ethereum (through the anon-rpc network), checks them,
 * and renders the site in a sandboxed frame. No gateway, no server, no wallet needed.
 */
export function Viewer(props: { ctx: navik.Ctx; name: string }) {
  const { ctx, name } = props
  const reads = useReads()
  const [input, setInput] = useState(name)
  const [progress, setProgress] = useState<{ step: string; done?: number; total?: number }>()
  const [loaded, setLoaded] = useState<Loaded>()
  const [error, setError] = useState<string>()
  const counters = useRef(reads)
  counters.current = reads

  useEffect(() => {
    setInput(name)
    setLoaded(undefined)
    setError(undefined)
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

  const ok = loaded && loaded.v.hashMatches && loaded.v.belongsToProject !== false

  return (
    <div class="viewer">
      <form
        class="open-form"
        onSubmit={(e) => {
          e.preventDefault()
          if (input) location.hash = `#/open/${input}`
        }}
      >
        <input
          placeholder={`portfolio.${ctx.deployment.root}, 3.portfolio, alice.eth`}
          value={input}
          onInput={(e) => setInput((e.currentTarget as HTMLInputElement).value.trim().toLowerCase())}
          aria-label="Name to open"
        />
        <button class="primary" disabled={!input}>
          Open
        </button>
      </form>

      {error && <p class="error">{error}</p>}
      {progress && (
        <p class="muted">
          {progress.step}
          {progress.total ? ` · chunk ${progress.done}/${progress.total}` : '…'}
          {reads.phase === 'connecting' && ' (connecting to the network first)'}
        </p>
      )}

      {loaded && (
        <>
          <Card title="Verified onchain" actions={<Badge tone={ok ? 'ok' : 'warn'}>{ok ? 'verified' : 'check failed'}</Badge>}>
            <ul class="checks">
              <li>
                ✓ <Mono>{loaded.v.name}</Mono> → <Mono>{loaded.v.deployment}</Mono> via ENS
              </li>
              {loaded.v.isNavikDeployment ? (
                <li>✓ a release created by the Navik factory{loaded.v.releaseName && <>, <Mono>{loaded.v.releaseName}</Mono></>}</li>
              ) : (
                <li class="muted">○ not a Navik release: any ERC-8244 contract, read as is</li>
              )}
              {loaded.v.belongsToProject !== undefined && (
                <li>{loaded.v.belongsToProject ? '✓ belongs to the named project' : '✗ does not belong to the named project'}</li>
              )}
              <li>
                {loaded.v.hashMatches ? '✓' : '✗'} {kb(loaded.v.html.length)} read from Ethereum, keccak256{' '}
                <Mono>{loaded.v.computedHash.slice(0, 18)}…</Mono>{' '}
                {loaded.v.isNavikDeployment ? (loaded.v.hashMatches ? 'matches the release manifest' : 'does NOT match the manifest') : ''}
              </li>
              {loaded.v.original && <li>✓ gzip-wrapped: decompressed to {kb(loaded.v.original.html.length)}</li>}
              <li class="muted small">
                {loaded.calls} calls, {kb(loaded.bytes)} in {(loaded.ms / 1000).toFixed(1)} s, routed as shown in the
                privacy panel
              </li>
            </ul>
            <CompareBuild v={loaded.v} />
          </Card>
          {ok && <SiteFrame v={loaded.v} />}
        </>
      )}
    </div>
  )
}

/** Drop a local build to check it is byte-identical to what is onchain (e.g. built from the repo). */
function CompareBuild(props: { v: navik.Verification }) {
  const [result, setResult] = useState<{ file: string; cmp: navik.BuildComparison }>()
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
        Compare with a local build (e.g. built from the source repo)
      </label>
      {result &&
        (result.cmp.matches ? (
          <p class="ok-text small">
            ✓ {result.file} is byte-identical to the {result.cmp.matched === 'original' ? 'original document' : 'release'}
          </p>
        ) : (
          <p class="error small">
            ✗ {result.file} differs (keccak256 <Mono>{result.cmp.hash.slice(0, 18)}…</Mono>)
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
      <div class="row site-bar">
        <span class="muted small">
          Sandboxed: the site runs in its own opaque origin, with no access to this page or your wallet.
        </span>
        <span class="spacer" />
        <button class="ghost small" onClick={() => frame.current?.requestFullscreen?.()}>
          Full screen
        </button>
      </div>
      <iframe
        ref={frame}
        class="site-frame"
        title={props.v.name}
        sandbox="allow-scripts allow-forms allow-popups allow-modals"
        srcdoc={html}
      />
    </div>
  )
}
