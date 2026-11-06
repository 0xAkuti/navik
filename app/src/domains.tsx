import * as navik from '@navik/sdk'
import { useCallback, useEffect, useState } from 'preact/hooks'
import { type Address, getAddress, zeroAddress } from 'viem'

import type { Run } from './app.tsx'
import { Addr, Avatar, Badge, Icon, Mono, Spinner, Who } from './ui.tsx'

const same = (a: Address, b: Address) => getAddress(a) === getAddress(b)

/** Who has to sign each step, for the account looking at it. */
function stepText(ctx: navik.Ctx, d: navik.Domain, step: navik.DomainStep, projectOwner: Address) {
  const who = (owner: Address) => (d.can[step] ? 'you' : <Who ctx={ctx} address={owner} chainId={ctx.deployment.chainId} />)
  if (step === 'record') return <>Link the name to production on the project's resolver · {who(projectOwner)}</>
  if (step === 'resolver') return <>Point the name at the project's resolver · {who(d.owner)}</>
  return <>Share the project's release registry, for {'<N>'}.{d.name} · {who(d.owner)}</>
}

function Steps(props: { ctx: navik.Ctx; domain: navik.Domain; projectOwner: Address }) {
  const d = props.domain
  return (
    <ol class="domain-steps">
      {navik.DOMAIN_STEPS.map((s) => (
        <li key={s} class={d.done[s] ? 'done' : ''}>
          <span class="step-mark">{d.done[s] ? <Icon name="check" size={13} /> : null}</span>
          <span>{stepText(props.ctx, d, s, props.projectOwner)}</span>
        </li>
      ))}
    </ol>
  )
}

const pending = (d: navik.Domain) => navik.DOMAIN_STEPS.filter((s) => !d.done[s])
const canFinish = (d: navik.Domain) => pending(d).some((s) => d.can[s])
const canUnlink = (d: navik.Domain) => navik.DOMAIN_STEPS.some((s) => d.done[s] && d.can[s])

/**
 * Custom domains: a name the user owns serves the project (ENSv2 namespace + record aliasing).
 * Linking needs the project owner (one resolver transaction) and the domain owner (two registry
 * transactions); when they differ, each finishes their part here.
 */
export function DomainsCard(props: { ctx: navik.Ctx; project: string; projectOwner: Address; busy: boolean; act: Run }) {
  const { ctx, project, busy, act } = props
  const [domains, setDomains] = useState<navik.Domain[]>()
  const [listError, setListError] = useState(false)
  const [input, setInput] = useState('')
  const [checked, setChecked] = useState<navik.Domain>()
  const [checkError, setCheckError] = useState<string>()
  const [checking, setChecking] = useState(false)
  const name = navik.projectName(ctx, project)

  const load = useCallback(async () => {
    setListError(false)
    try {
      setDomains(await navik.listDomains(ctx, project))
    } catch {
      setListError(true)
    }
  }, [ctx, project])
  useEffect(() => {
    setDomains(undefined)
    load()
  }, [load])

  const check = async (e?: Event) => {
    e?.preventDefault()
    const value = input.trim().toLowerCase()
    if (!value) return
    setChecked(undefined)
    setCheckError(undefined)
    setChecking(true)
    try {
      setChecked(await navik.domainStatus(ctx, project, value))
    } catch (err) {
      setCheckError(navik.describeError(err))
    } finally {
      setChecking(false)
    }
  }

  const link = async (domain: string) => {
    const ok = await act(`Linking ${domain}`, () => navik.linkDomain(ctx, project, domain))
    await load()
    if (!ok || checked?.name !== domain) return
    const after = await navik.domainStatus(ctx, project, domain).catch(() => undefined)
    // linked: the list shows it; partly linked: keep the steps in view
    if (after?.linked) {
      setChecked(undefined)
      setInput('')
    } else setChecked(after)
  }
  const unlink = async (domain: string) => {
    await act(`Unlinking ${domain}`, () => navik.unlinkDomain(ctx, project, domain))
    await load()
  }

  const txCount = (d: navik.Domain) => pending(d).filter((s) => d.can[s]).length

  return (
    <section>
      <h2 class="section-title">Domains</h2>
      <p class="muted small">
        Serve <Mono>{name}</Mono> from a name you own: <Mono>alice.eth</Mono> shows production and follows every promotion,{' '}
        <Mono>3.alice.eth</Mono> any release, <Mono>preview.alice.eth</Mono> the newest. ENSv2 aliasing does it: the name shares the
        project's release registry and its production record, with nothing copied.
      </p>

      <div class="card list">
        {domains === undefined && !listError ? (
          <div class="empty-row muted">
            <Spinner /> Reading linked names…
          </div>
        ) : listError ? (
          <div class="empty-row muted">Could not list domains from this RPC.</div>
        ) : domains!.length === 0 ? (
          <div class="empty-row muted">No domains linked yet.</div>
        ) : (
          domains!.map((d) => (
            <div key={d.name} class="key-row domain-row">
              <Avatar seed={d.name} size={24} />
              <a href={`#/open/${d.name}`}>
                <Mono>{d.name}</Mono>
              </a>
              {d.linked ? <Badge tone="ok">Linked</Badge> : <Badge tone="warn">Waiting for {pending(d).length} step{pending(d).length === 1 ? '' : 's'}</Badge>}
              <span class="spacer" />
              {!d.linked && canFinish(d) && (
                <button class="btn primary sm" disabled={busy} onClick={() => link(d.name)}>
                  Finish linking
                </button>
              )}
              {canUnlink(d) && (
                <button class="btn ghost sm" disabled={busy} onClick={() => unlink(d.name)}>
                  Unlink
                </button>
              )}
              {!d.linked && <Steps ctx={ctx} domain={d} projectOwner={props.projectOwner} />}
            </div>
          ))
        )}

        <form class="key-form" onSubmit={check}>
          <Icon name="globe" />
          <input
            placeholder="alice.eth, or a subname you own"
            value={input}
            onInput={(e) => {
              setInput((e.currentTarget as HTMLInputElement).value)
              setChecked(undefined)
              setCheckError(undefined)
            }}
          />
          <button class="btn sm" disabled={busy || checking || !input.trim()}>
            {checking ? <Spinner /> : 'Check'}
          </button>
        </form>
      </div>

      {checkError && <p class="error">{checkError}</p>}
      {checked && (
        <div class="card domain-check">
          <div class="row">
            <Avatar seed={checked.name} size={28} />
            <strong>{checked.name}</strong>
            {checked.linked && <Badge tone="ok">Linked</Badge>}
            <span class="muted small">
              owned by <Who ctx={ctx} address={checked.owner} chainId={ctx.deployment.chainId} />
            </span>
          </div>
          {!checked.linked && (
            <>
              <Steps ctx={ctx} domain={checked} projectOwner={props.projectOwner} />
              {!checked.done.resolver && !same(checked.resolver, zeroAddress) && (
                <p class="muted small">
                  While linked, {checked.name} resolves from the project: its own records (address, avatar…) and existing subnames are
                  hidden. Linking records what it points at now, and unlinking restores it: resolver{' '}
                  <Addr address={checked.resolver} chainId={ctx.deployment.chainId} />
                  {!same(checked.subregistry, zeroAddress) && (
                    <>
                      {' '}
                      and subregistry <Addr address={checked.subregistry} chainId={ctx.deployment.chainId} />
                    </>
                  )}
                </p>
              )}
              <div class="row">
                {canFinish(checked) ? (
                  <button class="btn primary sm" disabled={busy} onClick={() => link(checked.name)}>
                    Link {checked.name} ({txCount(checked)} transaction{txCount(checked) === 1 ? '' : 's'})
                  </button>
                ) : (
                  <span class="muted small">Your account cannot do any of the remaining steps.</span>
                )}
                {txCount(checked) < pending(checked).length && canFinish(checked) && (
                  <span class="muted small">The other owner finishes from this page or with `navik link`.</span>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </section>
  )
}
