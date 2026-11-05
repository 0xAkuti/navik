import * as navik from '@navik/sdk'
import { useCallback, useEffect, useState } from 'preact/hooks'
import { type Address, getAddress, isAddress } from 'viem'

import { Badge, Card, kb, Mono, shortAddr } from './ui.tsx'

type Run = (label: string, fn: () => Promise<unknown>) => Promise<boolean>

type Data = {
  owner: Address
  releases: navik.Release[]
  live?: Address
  perms: { owner: boolean; publish: boolean; promote: boolean }
  keys?: navik.KeyGrant[]
}

export function ProjectView(props: { ctx: navik.Ctx; project: string; account: Address; run: Run; busy: boolean }) {
  const { ctx, project, account, run, busy } = props
  const [data, setData] = useState<Data>()
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    setError(undefined)
    try {
      const owner = await navik.projectOwner(ctx, project)
      if (BigInt(owner) === 0n) throw new Error(`${navik.projectName(ctx, project)} is not claimed`)
      const [{ releases, live }, perms] = await Promise.all([
        navik.listReleases(ctx, project),
        navik.permissionsOf(ctx, project, account),
      ])
      const keys = perms.owner ? await navik.listKeys(ctx, project).catch(() => undefined) : undefined
      setData({ owner, releases, live, perms, keys })
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

  if (error) return <p class="error">{error}</p>
  if (!data) return <p class="muted">Loading {navik.projectName(ctx, project)}…</p>

  const liveRelease = data.live && data.releases.find((r) => getAddress(r.deployment) === getAddress(data.live!))
  const role = data.perms.owner ? 'owner' : data.perms.promote ? 'deploy + promote key' : data.perms.publish ? 'deploy key' : 'read only'

  return (
    <div class="project">
      <div class="project-head">
        <h1>{navik.projectName(ctx, project)}</h1>
        <div class="row">
          <Badge tone={data.perms.owner ? 'ok' : 'muted'}>{role}</Badge>
          <span class="muted">
            owner <Mono title={data.owner}>{shortAddr(data.owner)}</Mono>
          </span>
        </div>
      </div>

      <Card
        title="Production"
        actions={
          data.live &&
          data.perms.promote && (
            <button class="ghost" disabled={busy} onClick={() => act('Clearing production', () => navik.demote(ctx, project))}>
              Take offline
            </button>
          )
        }
      >
        {data.live ? (
          <p class="live">
            <Badge tone="ok">live</Badge> <strong>{navik.projectName(ctx, project)}</strong> →{' '}
            {liveRelease ? <Mono>{liveRelease.name}</Mono> : <Mono>{data.live}</Mono>}
          </p>
        ) : (
          <p class="muted">Nothing is live. Deploy a release and promote it.</p>
        )}
      </Card>

      {data.perms.publish && <DeployCard {...props} canPromote={data.perms.promote} act={act} />}

      <Card title={`Releases (${data.releases.length})`}>
        {data.releases.length === 0 ? (
          <p class="muted">No releases yet.</p>
        ) : (
          <table>
            <tbody>
              {[...data.releases].reverse().map((r) => {
                const isLive = !!data.live && getAddress(r.deployment) === getAddress(data.live)
                return (
                  <tr key={r.name} class={isLive ? 'is-live' : ''}>
                    <td>
                      <Mono>{r.name}</Mono>
                      <div class="muted small">
                        <Mono title={r.deployment}>{shortAddr(r.deployment)}</Mono> · {kb(r.size)} · {r.chunks} chunk
                        {r.chunks === 1 ? '' : 's'} · <span title={r.contentHash}>{r.contentHash.slice(0, 10)}…</span>
                      </div>
                    </td>
                    <td class="actions">
                      <button class="ghost" onClick={() => view(ctx, r.deployment)}>
                        View
                      </button>
                      {isLive ? (
                        <Badge tone="ok">live</Badge>
                      ) : (
                        data.perms.promote && (
                          <button
                            disabled={busy}
                            onClick={() => act(`Promoting ${r.name}`, () => navik.promote(ctx, project, r.deployment))}
                          >
                            {liveRelease && r.version < liveRelease.version ? 'Roll back' : 'Promote'}
                          </button>
                        )
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>

      {data.perms.owner && <KeysCard {...props} keys={data.keys} act={act} />}
    </div>
  )
}

/** Fetches a release from Ethereum, checks its hash, and opens it locally. */
async function view(ctx: navik.Ctx, deployment: Address) {
  const win = window.open('', '_blank')
  const v = await navik.verifyDeployment(ctx, deployment)
  if (!v.hashMatches) {
    win?.close()
    alert('Content hash mismatch: refusing to open this release.')
    return
  }
  const url = URL.createObjectURL(new Blob([v.html as BlobPart], { type: 'text/html' }))
  if (win) win.location.href = url
  else window.open(url, '_blank')
}

function DeployCard(props: {
  ctx: navik.Ctx
  project: string
  busy: boolean
  canPromote: boolean
  act: Run
}) {
  const { ctx, project, busy, canPromote, act } = props
  const [file, setFile] = useState<File>()
  const [plan, setPlan] = useState<navik.PublishPlan>()
  const [planError, setPlanError] = useState<string>()
  const [steps, setSteps] = useState<string[]>([])
  const [drag, setDrag] = useState(false)

  const pick = async (f?: File) => {
    setFile(f)
    setPlan(undefined)
    setPlanError(undefined)
    setSteps([])
    if (!f) return
    try {
      setPlan(await navik.planPublish(ctx, project, new Uint8Array(await f.arrayBuffer())))
    } catch (err) {
      setPlanError(navik.describeError(err))
    }
  }

  const deploy = async (promote: boolean) => {
    if (!plan) return
    setSteps([])
    const ok = await act(`Deploying ${plan.name}`, async () => {
      await navik.publish(ctx, plan, (s) =>
        setSteps((prev) => [...prev, s.kind === 'upload' ? `Uploaded ${s.chunks} chunk(s)` : `Published ${plan.name}`]),
      )
      if (promote) {
        await navik.promote(ctx, project, plan.predicted)
        setSteps((prev) => [...prev, `Promoted to ${navik.projectName(ctx, project)}`])
      }
    })
    if (ok) {
      setFile(undefined)
      setPlan(undefined)
    }
  }

  const reused = plan?.chunks.filter((c) => c.stored).length ?? 0
  const txs = plan ? (plan.singleTx ? 1 : plan.uploads.length + 1) : 0

  return (
    <Card title="Deploy">
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
        <input
          type="file"
          accept=".html,.htm,text/html"
          onChange={(e) => pick((e.currentTarget as HTMLInputElement).files?.[0])}
        />
        {file ? <strong>{file.name}</strong> : <span>Drop a single-file HTML build here, or click to choose</span>}
      </label>
      {planError && <p class="error">{planError}</p>}
      {plan && (
        <>
          <dl class="plan">
            <dt>Release</dt>
            <dd>
              <Mono>{plan.name}</Mono>
            </dd>
            <dt>Size</dt>
            <dd>
              {kb(plan.size)} in {plan.chunks.length} chunk{plan.chunks.length === 1 ? '' : 's'} ({reused} already
              onchain)
            </dd>
            <dt>Transactions</dt>
            <dd>
              {txs}
              {canPromote ? ' + 1 to promote' : ''}
            </dd>
            <dt>Address</dt>
            <dd>
              <Mono>{plan.predicted}</Mono>
            </dd>
          </dl>
          <div class="row">
            <button disabled={busy} onClick={() => deploy(false)}>
              Deploy
            </button>
            {canPromote && (
              <button class="primary" disabled={busy} onClick={() => deploy(true)}>
                Deploy and promote
              </button>
            )}
          </div>
        </>
      )}
      {steps.length > 0 && (
        <ul class="steps">
          {steps.map((s) => (
            <li key={s}>✓ {s}</li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function KeysCard(props: { ctx: navik.Ctx; project: string; busy: boolean; keys?: navik.KeyGrant[]; act: Run }) {
  const { ctx, project, busy, keys, act } = props
  const [address, setAddress] = useState('')
  const [permission, setPermission] = useState<navik.Permission>('publish')
  const valid = isAddress(address)

  return (
    <Card title="Deploy keys">
      <p class="muted small">
        Let a CI or teammate key ship releases (<em>deploy</em>) and optionally change production (<em>promote</em>) on
        this project only. Enforced by ENSv2 permissions on the project's resolver; revoke any time.
      </p>
      {keys === undefined ? (
        <p class="muted small">Could not list keys from this RPC.</p>
      ) : keys.length === 0 ? (
        <p class="muted small">No keys granted.</p>
      ) : (
        <table>
          <tbody>
            {keys.map((k) => (
              <tr key={k.account}>
                <td>
                  <Mono>{k.account}</Mono>
                </td>
                <td class="actions">
                  {(['publish', 'promote'] as const)
                    .filter((p) => k[p])
                    .map((p) => (
                      <button
                        key={p}
                        class="ghost"
                        disabled={busy}
                        onClick={() => act(`Revoking ${p}`, () => navik.revoke(ctx, project, k.account, p))}
                      >
                        Revoke {p === 'publish' ? 'deploy' : 'promote'}
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form
        class="row"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!valid) return
          if (await act(`Granting ${permission}`, () => navik.grant(ctx, project, getAddress(address), permission))) {
            setAddress('')
          }
        }}
      >
        <input
          placeholder="0x… key address"
          value={address}
          onInput={(e) => setAddress((e.currentTarget as HTMLInputElement).value.trim())}
        />
        <select
          value={permission}
          onChange={(e) => setPermission((e.currentTarget as HTMLSelectElement).value as navik.Permission)}
        >
          <option value="publish">can deploy</option>
          <option value="promote">can promote</option>
        </select>
        <button disabled={busy || !valid}>Grant</button>
      </form>
    </Card>
  )
}
