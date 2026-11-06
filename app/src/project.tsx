import * as navik from '@navik/sdk'
import { useCallback, useEffect, useState } from 'preact/hooks'
import { type Address, getAddress, isAddress } from 'viem'

import type { Run } from './app.tsx'
import { Addr, Avatar, Badge, Hash, Icon, kb, Modal, Mono, Spinner } from './ui.tsx'

type Data = {
  owner: Address
  releases: navik.Release[]
  live?: Address
  preview?: Address
  perms: { owner: boolean; publish: boolean; promote: boolean }
  keys?: navik.KeyGrant[]
}

const same = (a?: Address, b?: Address) => !!a && !!b && getAddress(a) === getAddress(b)

export function ProjectView(props: { ctx: navik.Ctx; project: string; tab?: string; account: Address; run: Run; busy: boolean }) {
  const { ctx, project, account, run, busy } = props
  const [data, setData] = useState<Data>()
  const [error, setError] = useState<string>()
  const [deploying, setDeploying] = useState(false)
  const name = navik.projectName(ctx, project)

  const load = useCallback(async () => {
    setError(undefined)
    try {
      const owner = await navik.projectOwner(ctx, project)
      if (BigInt(owner) === 0n) throw new Error(`${name} is not claimed`)
      const [{ releases, live, preview }, perms] = await Promise.all([
        navik.listReleases(ctx, project),
        navik.permissionsOf(ctx, project, account),
      ])
      const keys = perms.owner ? await navik.listKeys(ctx, project).catch(() => undefined) : undefined
      setData({ owner, releases, live, preview, perms, keys })
    } catch (err) {
      setError(navik.describeError(err))
    }
  }, [ctx, project, account])

  useEffect(() => {
    setData(undefined)
    load()
  }, [load])

  const act: Run = async (label, fn) => {
    const ok = await run(label, fn)
    await load()
    return ok
  }

  if (error)
    return (
      <div class="page">
        <p class="error">{error}</p>
      </div>
    )

  const role = !data
    ? undefined
    : data.perms.owner
      ? 'Owner'
      : data.perms.promote
        ? 'Deploy + promote key'
        : data.perms.publish
          ? 'Deploy key'
          : 'Read only'
  const tab = props.tab === 'access' ? 'access' : 'releases'

  return (
    <div class="page">
      <div class="page-head">
        <div class="title">
          <Avatar seed={name} size={44} />
          <div>
            <h1>{name}</h1>
            <div class="muted small row">
              {role && <Badge tone={data?.perms.owner ? 'blue' : 'muted'}>{role}</Badge>}
              {data && (
                <span>
                  owned by <Addr address={data.owner} chainId={ctx.deployment.chainId} />
                </span>
              )}
            </div>
          </div>
        </div>
        <div class="row">
          <a class="btn" href={`#/open/${name}`}>
            Visit <Icon name="arrow" size={14} />
          </a>
          {data?.perms.publish && (
            <button class="btn primary" onClick={() => setDeploying(true)}>
              <Icon name="upload" size={15} /> Deploy
            </button>
          )}
        </div>
      </div>

      <nav class="tabs">
        <a class={tab === 'releases' ? 'active' : ''} href={`#/p/${project}`}>
          Releases
        </a>
        <a class={tab === 'access' ? 'active' : ''} href={`#/p/${project}/access`}>
          Access
        </a>
      </nav>

      {!data ? (
        <div class="card production skeleton" />
      ) : tab === 'access' ? (
        <AccessCard ctx={ctx} project={project} data={data} busy={busy} act={act} />
      ) : (
        <>
          <Production ctx={ctx} project={project} data={data} busy={busy} act={act} onDeploy={() => setDeploying(true)} />
          <Releases ctx={ctx} project={project} data={data} busy={busy} act={act} />
        </>
      )}

      {deploying && data && (
        <DeployModal ctx={ctx} project={project} canPromote={data.perms.promote} busy={busy} act={act} onClose={() => setDeploying(false)} />
      )}
    </div>
  )
}

function Production(props: { ctx: navik.Ctx; project: string; data: Data; busy: boolean; act: Run; onDeploy: () => void }) {
  const { ctx, project, data, busy, act } = props
  const live = data.releases.find((r) => same(r.deployment, data.live))
  const preview = data.releases.find((r) => same(r.deployment, data.preview))
  const name = navik.projectName(ctx, project)

  return (
    <section class="card production">
      <div class="thumb">{live ? <Thumbnail ctx={ctx} release={live} project={project} /> : <div class="thumb-empty">No production</div>}</div>
      <dl class="prod-info">
        <dt>Production</dt>
        <dd class="prod-live">
          {data.live ? (
            <>
              <span class="status">
                <i class="dot ok" /> Live
              </span>{' '}
              <a href={`#/open/${name}`}>
                <Mono>{name}</Mono>
              </a>{' '}
              <span class="muted">→</span> <Mono>{live?.name ?? data.live}</Mono>
            </>
          ) : (
            <span class="muted">Nothing is live. Deploy a release and promote it.</span>
          )}
        </dd>
        {preview && (
          <>
            <dt>Preview</dt>
            <dd>
              <a href={`#/open/${navik.previewName(ctx, project)}`}>
                <Mono>{navik.previewName(ctx, project)}</Mono>
              </a>{' '}
              <span class="muted">→</span> <Mono>{preview.name}</Mono> <span class="muted small">(newest release)</span>
            </dd>
          </>
        )}
        {live && (
          <>
            <dt>Content</dt>
            <dd class="muted">
              {kb(live.size)} · {live.chunks} chunk{live.chunks === 1 ? '' : 's'} ·{' '}
              <Hash value={live.contentHash} />
            </dd>
          </>
        )}
        <dd class="prod-actions">
          {!data.releases.length && data.perms.publish && (
            <button class="btn primary sm" onClick={props.onDeploy}>
              <Icon name="upload" size={14} /> Deploy your first release
            </button>
          )}
          {data.live && data.perms.promote && (
            <button class="btn sm" disabled={busy} onClick={() => act('Taking production offline', () => navik.demote(ctx, project))}>
              Take offline
            </button>
          )}
        </dd>
      </dl>
    </section>
  )
}

/** A live, scaled-down render of production, read and hash-checked like any other view. */
function Thumbnail(props: { ctx: navik.Ctx; release: navik.Release; project: string }) {
  const [html, setHtml] = useState<string>()
  useEffect(() => {
    setHtml(undefined)
    navik
      .verifyDeployment(props.ctx, props.release.deployment, props.release.name, props.project)
      .then((v) => v.hashMatches && setHtml(new TextDecoder().decode(v.original?.html ?? v.html)), () => undefined)
  }, [props.ctx, props.release.deployment])
  if (!html)
    return (
      <div class="thumb-empty">
        <Spinner />
      </div>
    )
  return <iframe class="thumb-frame" title="Production preview" sandbox="allow-scripts" srcdoc={html} tabIndex={-1} />
}

function Releases(props: { ctx: navik.Ctx; project: string; data: Data; busy: boolean; act: Run }) {
  const { ctx, project, data, busy, act } = props
  const live = data.releases.find((r) => same(r.deployment, data.live))
  return (
    <section>
      <h2 class="section-title">Releases</h2>
      {data.releases.length === 0 ? (
        <div class="card empty-row muted">No releases yet.</div>
      ) : (
        <div class="card list">
          {[...data.releases].reverse().map((r) => {
            const isLive = same(r.deployment, data.live)
            const isPreview = same(r.deployment, data.preview)
            return (
              <div key={r.name} class={`release ${isLive ? 'is-live' : ''}`}>
                <i class={`dot ${isLive ? 'ok' : ''}`} />
                <div class="release-main">
                  <div class="row">
                    <a href={`#/open/${r.name}`} class="release-name">
                      <Mono>{r.name}</Mono>
                    </a>
                    {isLive && <Badge tone="ok">Production</Badge>}
                    {isPreview && <Badge tone="blue">Preview</Badge>}
                  </div>
                  <div class="muted small">
                    <Addr address={r.deployment} chainId={ctx.deployment.chainId} /> · {kb(r.size)} · {r.chunks} chunk
                    {r.chunks === 1 ? '' : 's'} · <Hash value={r.contentHash} chars={10} />
                  </div>
                </div>
                <div class="release-actions">
                  <a class="btn ghost sm" href={`#/open/${r.name}`}>
                    View
                  </a>
                  {!isLive && data.perms.promote && (
                    <button class="btn sm" disabled={busy} onClick={() => act(`Promoting ${r.name}`, () => navik.promote(ctx, project, r.deployment))}>
                      {live && r.version < live.version ? 'Roll back' : 'Promote'}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}

function DeployModal(props: { ctx: navik.Ctx; project: string; busy: boolean; canPromote: boolean; act: Run; onClose: () => void }) {
  const { ctx, project, busy, canPromote, act } = props
  const [file, setFile] = useState<File>()
  const [compress, setCompress] = useState(false)
  const [plan, setPlan] = useState<navik.PublishPlan>()
  const [planError, setPlanError] = useState<string>()
  const [steps, setSteps] = useState<string[]>([])
  const [done, setDone] = useState(false)
  const [drag, setDrag] = useState(false)

  const pick = async (f: File | undefined, gzip = compress) => {
    setFile(f)
    setPlan(undefined)
    setPlanError(undefined)
    setSteps([])
    setDone(false)
    if (!f) return
    try {
      setPlan(await navik.planPublish(ctx, project, new Uint8Array(await f.arrayBuffer()), { compress: gzip }))
    } catch (err) {
      setPlanError(navik.describeError(err))
    }
  }

  const deploy = async (promote: boolean) => {
    if (!plan) return
    setSteps([])
    const ok = await act(`Deploying ${plan.name}`, async () => {
      await navik.publish(ctx, plan, (s) =>
        setSteps((prev) => [...prev, s.kind === 'upload' ? `Uploaded ${s.chunks} chunk${s.chunks === 1 ? '' : 's'}` : `Published ${plan.name}`]),
      )
      if (promote) {
        await navik.promote(ctx, project, plan.predicted)
        setSteps((prev) => [...prev, `Promoted to ${navik.projectName(ctx, project)}`])
      }
    })
    setDone(ok)
  }

  const reused = plan?.chunks.filter((c) => c.stored).length ?? 0
  const txs = plan ? (plan.singleTx ? 1 : plan.uploads.length + 1) : 0
  const working = busy && !!plan && !done

  return (
    <Modal title={`Deploy to ${navik.projectName(ctx, project)}`} onClose={props.onClose} wide>
      {!done && (
        <>
          <label
            class={`drop ${drag ? 'drag' : ''}`}
            onDragOver={(e) => {
              e.preventDefault()
              setDrag(true)
            }}
            onDragLeave={() => setDrag(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDrag(false)
              pick(e.dataTransfer?.files[0])
            }}
          >
            <input type="file" accept=".html,.htm,text/html" onChange={(e) => pick((e.currentTarget as HTMLInputElement).files?.[0])} />
            <span class="feature-icon">
              <Icon name="upload" size={18} />
            </span>
            {file ? (
              <span>
                <strong>{file.name}</strong> <span class="muted">· {kb(file.size)} · click to change</span>
              </span>
            ) : (
              <span>
                <strong>Drop a single-file HTML build</strong> <span class="muted">or click to choose</span>
              </span>
            )}
          </label>
          <label class="toggle">
            <input
              type="checkbox"
              checked={compress}
              onChange={(e) => {
                const on = (e.currentTarget as HTMLInputElement).checked
                setCompress(on)
                if (file) pick(file, on)
              }}
            />
            <span>
              <strong>Compress (gzip)</strong>
              <span class="muted small"> fewer chunks and lower cost; the site then needs JavaScript to render</span>
            </span>
          </label>
        </>
      )}
      {planError && <p class="error">{planError}</p>}
      {plan && (
        <dl class="plan">
          <dt>Release</dt>
          <dd>
            <Mono>{plan.name}</Mono>
          </dd>
          <dt>Size</dt>
          <dd>
            {kb(plan.size)} in {plan.chunks.length} chunk{plan.chunks.length === 1 ? '' : 's'}{' '}
            <span class="muted">({reused} already onchain)</span>
            {plan.compressed && (
              <span class="muted">
                {' '}
                · compressed from {kb(plan.compressed.originalSize)}, {plan.compressed.originalChunks} chunk
                {plan.compressed.originalChunks === 1 ? '' : 's'}
              </span>
            )}
          </dd>
          <dt>Transactions</dt>
          <dd>
            {txs}
            {canPromote ? ' + 1 to promote' : ''}
          </dd>
          <dt>Address</dt>
          <dd>
            <Addr address={plan.predicted} full link={false} /> <span class="muted small">known before upload</span>
          </dd>
        </dl>
      )}
      {(steps.length > 0 || working) && (
        <ol class="steps">
          {steps.map((s) => (
            <li key={s}>
              <Icon name="check" size={14} /> {s}
            </li>
          ))}
          {working && (
            <li class="muted">
              <Spinner /> Waiting for your wallet and the chain…
            </li>
          )}
        </ol>
      )}
      <footer class="modal-foot">
        {done ? (
          <>
            <a class="btn" href={`#/open/${plan?.name}`} onClick={props.onClose}>
              View release <Icon name="arrow" size={14} />
            </a>
            <button class="btn primary" onClick={props.onClose}>
              Done
            </button>
          </>
        ) : (
          plan && (
            <>
              <button class="btn" disabled={busy} onClick={() => deploy(false)}>
                Deploy
              </button>
              {canPromote && (
                <button class="btn primary" disabled={busy} onClick={() => deploy(true)}>
                  Deploy and promote
                </button>
              )}
            </>
          )
        )}
      </footer>
    </Modal>
  )
}

function AccessCard(props: { ctx: navik.Ctx; project: string; data: Data; busy: boolean; act: Run }) {
  const { ctx, project, data, busy, act } = props
  const [address, setAddress] = useState('')
  const [permission, setPermission] = useState<navik.Permission>('publish')
  const valid = isAddress(address)
  const keys = data.keys

  return (
    <section>
      <h2 class="section-title">Deploy keys</h2>
      <p class="muted small">
        Let a CI or teammate key ship releases (<em>deploy</em>) and optionally change production (<em>promote</em>) on
        this project only. Enforced by ENSv2 permissions on the project's resolver; revoke any time.
      </p>
      {!data.perms.owner ? (
        <div class="card empty-row muted">Only the project owner manages keys.</div>
      ) : (
        <div class="card list">
          {keys === undefined ? (
            <div class="empty-row muted">Could not list keys from this RPC.</div>
          ) : keys.length === 0 ? (
            <div class="empty-row muted">No keys granted.</div>
          ) : (
            keys.map((k) => (
              <div key={k.account} class="key-row">
                <Avatar seed={k.account.toLowerCase()} size={24} />
                <Addr address={k.account} chainId={ctx.deployment.chainId} full />
                {k.publish && <Badge tone="blue">deploy</Badge>}
                {k.promote && <Badge tone="blue">promote</Badge>}
                <span class="spacer" />
                {(['publish', 'promote'] as const)
                  .filter((p) => k[p])
                  .map((p) => (
                    <button key={p} class="btn ghost sm" disabled={busy} onClick={() => act(`Revoking ${p}`, () => navik.revoke(ctx, project, k.account, p))}>
                      Revoke {p === 'publish' ? 'deploy' : 'promote'}
                    </button>
                  ))}
              </div>
            ))
          )}
          <form
            class="key-form"
            onSubmit={async (e) => {
              e.preventDefault()
              if (!valid) return
              if (await act(`Granting ${permission}`, () => navik.grant(ctx, project, getAddress(address), permission))) setAddress('')
            }}
          >
            <Icon name="key" />
            <input placeholder="0x… key address" value={address} onInput={(e) => setAddress((e.currentTarget as HTMLInputElement).value.trim())} />
            <select value={permission} onChange={(e) => setPermission((e.currentTarget as HTMLSelectElement).value as navik.Permission)}>
              <option value="publish">can deploy</option>
              <option value="promote">can promote</option>
            </select>
            <button class="btn primary sm" disabled={busy || !valid}>
              Grant
            </button>
          </form>
        </div>
      )}
    </section>
  )
}
