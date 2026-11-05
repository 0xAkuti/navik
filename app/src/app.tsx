import * as navik from '@navik/sdk'
import { useEffect, useMemo, useState } from 'preact/hooks'
import type { Address } from 'viem'

import { ProjectView } from './project.tsx'
import { Badge, Mono, shortAddr } from './ui.tsx'
import {
  deployments,
  discoverWallets,
  makeCtx,
  readChainId,
  requestAccount,
  store,
  switchChain,
  type WalletInfo,
} from './wallet.ts'

const route = () => decodeURIComponent(location.hash.replace(/^#\/?/, ''))

export function App() {
  const [wallets, setWallets] = useState<WalletInfo[]>([])
  const [wallet, setWallet] = useState<WalletInfo>()
  const [account, setAccount] = useState<Address>()
  const [chainId, setChainId] = useState<number>()
  const [selected, setSelected] = useState(route())
  const [busy, setBusy] = useState<string>()
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string }>()

  useEffect(() => discoverWallets(setWallets), [])
  useEffect(() => {
    const onHash = () => setSelected(route())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    if (!wallet) return
    const p = wallet.provider
    const onAccounts = (accounts: string[]) => setAccount(accounts[0] as Address | undefined)
    const onChain = (id: string) => setChainId(Number(id))
    p.on('accountsChanged', onAccounts)
    p.on('chainChanged', onChain)
    return () => {
      p.removeListener('accountsChanged', onAccounts)
      p.removeListener('chainChanged', onChain)
    }
  }, [wallet])

  const ctx = useMemo(
    () => (wallet && chainId !== undefined ? makeCtx(wallet.provider, chainId, account) : undefined),
    [wallet, chainId, account],
  )

  const connect = async (w: WalletInfo) => {
    try {
      setAccount(await requestAccount(w.provider))
      setChainId(await readChainId(w.provider))
      setWallet(w)
    } catch (err) {
      setNotice({ tone: 'error', text: navik.describeError(err) })
    }
  }

  /** Runs one user action that sends transactions; reports the outcome. */
  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    setNotice(undefined)
    try {
      await fn()
      setNotice({ tone: 'ok', text: `${label}: done` })
      return true
    } catch (err) {
      setNotice({ tone: 'error', text: `${label} failed: ${navik.describeError(err)}` })
      return false
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <>
      <header class="top">
        <a class="brand" href="#/">
          navik
        </a>
        {ctx && <RootStatus ctx={ctx} />}
        <span class="spacer" />
        {account ? (
          <span class="account">
            <span class="dot" /> <Mono title={account}>{shortAddr(account)}</Mono>
          </span>
        ) : null}
      </header>

      {busy && <div class="status">{busy}… confirm in your wallet</div>}
      {notice && (
        <div class={`status ${notice.tone}`} onClick={() => setNotice(undefined)}>
          {notice.text}
        </div>
      )}

      <main>
        {!wallet || !account ? (
          <Welcome wallets={wallets} connect={connect} />
        ) : !ctx ? (
          <WrongChain chainId={chainId} provider={wallet} onError={(text) => setNotice({ tone: 'error', text })} />
        ) : (
          <div class="layout">
            <Sidebar ctx={ctx} account={account} selected={selected} run={run} busy={!!busy} />
            <div class="content">
              {selected ? (
                <ProjectView ctx={ctx} project={selected} account={account} run={run} busy={!!busy} />
              ) : (
                <Intro ctx={ctx} />
              )}
            </div>
          </div>
        )}
      </main>
    </>
  )
}

function Welcome(props: { wallets: WalletInfo[]; connect: (w: WalletInfo) => void }) {
  return (
    <div class="welcome">
      <h1>Websites that live on Ethereum, named by ENS.</h1>
      <p>
        Deploy a single-file site as an immutable contract, get a permanent name for every release (
        <Mono>3.site.navik.eth</Mono>), and choose what <Mono>site.navik.eth</Mono> serves. No servers.
      </p>
      {props.wallets.length === 0 ? (
        <p class="muted">No browser wallet found. Install one to manage projects.</p>
      ) : (
        <div class="wallets">
          {props.wallets.map((w) => (
            <button key={w.id} class="primary" onClick={() => props.connect(w)}>
              {w.icon && <img src={w.icon} alt="" />}
              Connect {w.name}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function WrongChain(props: { chainId?: number; provider: WalletInfo; onError: (text: string) => void }) {
  return (
    <div class="welcome">
      <h1>Navik is not deployed on chain {props.chainId}.</h1>
      <div class="wallets">
        {Object.keys(deployments).map((id) => (
          <button
            key={id}
            class="primary"
            onClick={() => switchChain(props.provider.provider, Number(id)).catch((e) => props.onError(navik.describeError(e)))}
          >
            Switch to {Number(id) === 1 ? 'Ethereum' : `chain ${id}`}
          </button>
        ))}
      </div>
    </div>
  )
}

function RootStatus(props: { ctx: navik.Ctx }) {
  const [status, setStatus] = useState<navik.RootStatus>()
  useEffect(() => {
    navik.rootStatus(props.ctx).then(setStatus, () => setStatus(undefined))
  }, [props.ctx])
  if (!status) return null
  return status.frozen ? (
    <Badge tone="ok">{props.ctx.deployment.root} frozen</Badge>
  ) : (
    <span title={`The ${props.ctx.deployment.root} owner can still repoint the namespace`}>
      <Badge tone="warn">testing phase</Badge>
    </span>
  )
}

function Intro(props: { ctx: navik.Ctx }) {
  const root = props.ctx.deployment.root
  return (
    <div class="intro">
      <h1>Your projects</h1>
      <ol>
        <li>
          Claim a name: <Mono>{`<project>.${root}`}</Mono> is yours permanently. Nobody, including Navik, can take it.
        </li>
        <li>
          Deploy a single-file HTML build. Every release is an immutable contract with its own name,{' '}
          <Mono>{`<N>.<project>.${root}`}</Mono>, and <Mono>{`preview.<project>.${root}`}</Mono> follows
          the newest one.
        </li>
        <li>Promote a release to production, roll back with one click, or grant deploy keys to CI.</li>
      </ol>
    </div>
  )
}

function Sidebar(props: {
  ctx: navik.Ctx
  account: Address
  selected: string
  run: (label: string, fn: () => Promise<unknown>) => Promise<boolean>
  busy: boolean
}) {
  const { ctx, account, selected, run, busy } = props
  const key = `navik:projects:${ctx.deployment.chainId}:${account}`
  const [remembered, setRemembered] = useState<string[]>(() => store.get(key, []))
  const [owned, setOwned] = useState<string[]>([])
  const [name, setName] = useState('')
  const [open, setOpen] = useState('')

  useEffect(() => {
    setRemembered(store.get(key, []))
    navik.projectsOf(ctx, account).then(setOwned, () => setOwned([]))
  }, [ctx, account, key])

  const remember = (project: string) => {
    const next = [...new Set([...remembered, project])]
    setRemembered(next)
    store.set(key, next)
  }

  const projects = [...new Set([...owned, ...remembered])].sort()
  const valid = navik.isValidProjectLabel(name)

  return (
    <aside class="sidebar">
      <nav>
        {projects.length === 0 && <p class="muted small">No projects yet.</p>}
        {projects.map((p) => (
          <a key={p} href={`#/${p}`} class={p === selected ? 'active' : ''}>
            {p}
            <span class="muted">.{ctx.deployment.root}</span>
          </a>
        ))}
      </nav>

      <form
        onSubmit={async (e) => {
          e.preventDefault()
          if (!valid) return
          const project = name
          if (await run(`Claiming ${project}.${ctx.deployment.root}`, () => navik.claim(ctx, project))) {
            remember(project)
            setName('')
            location.hash = `#/${project}`
          }
        }}
      >
        <label class="small muted">New project</label>
        <div class="suffix">
          <input
            placeholder="my-site"
            value={name}
            onInput={(e) => setName((e.currentTarget as HTMLInputElement).value.trim().toLowerCase())}
          />
          <span>.{ctx.deployment.root}</span>
        </div>
        {name && !valid && <p class="error small">3–63 of a-z, 0-9, -; not ending in -v&lt;number&gt;</p>}
        <button class="primary" disabled={busy || !valid}>
          Claim
        </button>
      </form>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          const project = open.replace(new RegExp(`\\.${ctx.deployment.root.replace('.', '\\.')}$`), '')
          if (!project) return
          remember(project)
          setOpen('')
          location.hash = `#/${project}`
        }}
      >
        <label class="small muted">Open a project you have a key for</label>
        <input placeholder="project name" value={open} onInput={(e) => setOpen((e.currentTarget as HTMLInputElement).value.trim())} />
      </form>
    </aside>
  )
}
