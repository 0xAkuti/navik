import * as navik from '@navik/sdk'
import { useEffect, useMemo, useState } from 'preact/hooks'
import type { Address } from 'viem'

import { PrivacyPanel, PrivacyPill } from './privacy.tsx'
import { ProjectView } from './project.tsx'
import { loggedWallet, useReads } from './reads.ts'
import { store } from './store.ts'
import { Addr, Avatar, Badge, CopyButton, Icon, Info, Logo, Modal, Mono, primaryName, shortAddr, Spinner } from './ui.tsx'
import { Viewer } from './viewer.tsx'
import {
  defaultChainId,
  deployments,
  discoverWallets,
  makeCtx,
  readChainId,
  requestAccount,
  switchChain,
  type WalletInfo,
} from './wallet.ts'

export type Run = (label: string, fn: () => Promise<unknown>) => Promise<boolean>

/** `#/`, `#/new`, `#/p/<project>[/domains|/access]`, `#/open/<name>` */
type Route = { page: 'home' | 'new' | 'project' | 'open'; arg: string; tab?: string }
function parseRoute(): Route {
  const [page, arg = '', tab] = decodeURIComponent(location.hash.replace(/^#\/?/, '')).split('/')
  if (page === 'new') return { page: 'new', arg }
  if (page === 'p' && arg) return { page: 'project', arg, tab }
  if (page === 'open') return { page: 'open', arg }
  return { page: 'home', arg: '' }
}

export function App() {
  const [wallets, setWallets] = useState<WalletInfo[]>([])
  const [wallet, setWallet] = useState<WalletInfo>()
  const [account, setAccount] = useState<Address>()
  const [chainId, setChainId] = useState<number>()
  const [route, setRoute] = useState(parseRoute())
  const [busy, setBusy] = useState<string>()
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string }>()
  const [panel, setPanel] = useState(false)
  const [picker, setPicker] = useState(false)
  const reads = useReads()

  useEffect(() => discoverWallets(setWallets), [])
  useEffect(() => {
    const onHash = () => {
      setRoute(parseRoute())
      window.scrollTo(0, 0)
    }
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

  useEffect(() => {
    if (notice?.tone !== 'ok') return
    const t = setTimeout(() => setNotice(undefined), 5000)
    return () => clearTimeout(t)
  }, [notice])

  // reads.settings: a new network or RPC rebuilds the clients
  const ctx = useMemo(
    () =>
      wallet && chainId !== undefined
        ? makeCtx(chainId, { provider: wallet.provider, account }, account && `account:${account}`)
        : undefined,
    [wallet, chainId, account, reads.settings],
  )
  // reading needs no wallet: the connected chain if Navik is on it, otherwise the default
  const viewing = route.page === 'open' ? route.arg : undefined
  const readChain = chainId !== undefined && deployments[chainId] ? chainId : defaultChainId
  const readCtx = useMemo(
    () => makeCtx(readChain, undefined, viewing ? `site:${viewing}` : undefined),
    [readChain, viewing, reads.settings],
  )

  const connect = async (info: WalletInfo) => {
    const w = { ...info, provider: loggedWallet(info.provider, info.name) }
    try {
      setAccount(await requestAccount(w.provider))
      setChainId(await readChainId(w.provider))
      setWallet(w)
      setPicker(false)
    } catch (err) {
      setNotice({ tone: 'error', text: navik.describeError(err) })
    }
  }

  /** Runs one user action that sends transactions; reports the outcome. */
  const run: Run = async (label, fn) => {
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

  const connected = !!wallet && !!account
  const needsWallet = route.page === 'new' || route.page === 'project' || (route.page === 'home' && connected)

  return (
    <>
      <header class="nav">
        <div class="nav-inner">
          <a class="brand" href="#/">
            <Logo /> Navik
          </a>
          {route.page === 'project' && (
            <>
              <span class="slash">/</span>
              <a class="crumb" href={`#/p/${route.arg}`}>
                <Avatar seed={`${route.arg}.${readCtx?.deployment.root}`} size={18} />
                {route.arg}
              </a>
            </>
          )}
          {readCtx && <RootStatus ctx={ctx ?? readCtx} />}
          <span class="spacer" />
          <a class={`nav-link ${route.page === 'open' ? 'active' : ''}`} href="#/open/">
            Open a site
          </a>
          <PrivacyPill open={panel} onToggle={() => setPanel(!panel)} />
          {connected ? (
            <AccountChip ctx={ctx ?? readCtx} account={account!} />
          ) : (
            <button class="btn primary sm" onClick={() => setPicker(true)}>
              Connect
            </button>
          )}
        </div>
      </header>

      <main>
        {viewing !== undefined ? (
          readCtx ? (
            <Viewer ctx={readCtx} name={viewing} wallet={wallet && account ? { provider: wallet.provider, account } : undefined} />
          ) : (
            <p class="error">Navik is not deployed on chain {readChain}.</p>
          )
        ) : !needsWallet || !connected ? (
          <Landing onConnect={() => setPicker(true)} root={readCtx?.deployment.root ?? 'navik.eth'} />
        ) : !ctx ? (
          <WrongChain chainId={chainId} provider={wallet!} onError={(text) => setNotice({ tone: 'error', text })} />
        ) : route.page === 'new' ? (
          <NewProject ctx={ctx} account={account!} run={run} busy={!!busy} />
        ) : route.page === 'project' ? (
          <ProjectView ctx={ctx} project={route.arg} tab={route.tab} account={account!} run={run} busy={!!busy} />
        ) : (
          <Projects ctx={ctx} account={account!} />
        )}
      </main>

      {picker && <WalletPicker wallets={wallets} connect={connect} onClose={() => setPicker(false)} />}
      {panel && <PrivacyPanel onClose={() => setPanel(false)} />}
      <div class="toasts" aria-live="polite">
        {busy && (
          <div class="toast">
            <Spinner /> {busy}… confirm in your wallet
          </div>
        )}
        {notice && (
          <div class={`toast ${notice.tone}`} role="status">
            <Icon name={notice.tone === 'ok' ? 'check' : 'x'} />
            <span>{notice.text}</span>
            <button class="icon-btn" onClick={() => setNotice(undefined)} aria-label="Dismiss">
              <Icon name="x" size={14} />
            </button>
          </div>
        )}
      </div>
    </>
  )
}

/** The account as ENS shows it: its primary name if it has one, read privately like everything else. */
function AccountChip(props: { ctx?: navik.Ctx; account: Address }) {
  const [name, setName] = useState<string>()
  useEffect(() => {
    setName(undefined)
    if (props.ctx) primaryName(props.ctx, props.account).then(setName)
  }, [props.ctx, props.account])
  return (
    <span class="chip" title={props.account}>
      <Avatar seed={props.account.toLowerCase()} size={20} />
      {name ?? <Addr address={props.account} chainId={props.ctx?.deployment.chainId} />}
      {name && <CopyButton value={props.account} />}
    </span>
  )
}

function WalletPicker(props: { wallets: WalletInfo[]; connect: (w: WalletInfo) => void; onClose: () => void }) {
  return (
    <Modal title="Connect a wallet" info="Your wallet only signs. Reads go through an anonymizing network." onClose={props.onClose}>
      {props.wallets.length === 0 ? (
        <p class="muted">No browser wallet found.</p>
      ) : (
        <div class="wallet-list">
          {props.wallets.map((w) => (
            <button key={w.id} class="wallet-option" onClick={() => props.connect(w)}>
              {w.icon ? <img src={w.icon} alt="" /> : <Avatar seed={w.name} size={28} />}
              <span>{w.name}</span>
              <Icon name="chevron" />
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}

function Landing(props: { onConnect: () => void; root: string }) {
  const [name, setName] = useState('')
  const site = `portfolio.${props.root}`
  return (
    <div class="landing">
      <section class="hero">
        <div>
          <h1>Ship websites to Ethereum.</h1>
          <p class="lead">Immutable websites on Ethereum, named with ENS.</p>
          <form
            class="search"
            onSubmit={(e) => {
              e.preventDefault()
              if (name) location.hash = `#/open/${name}`
            }}
          >
            <Icon name="search" size={18} />
            <input
              placeholder={`Open ${site}`}
              value={name}
              aria-label="Name to open"
              onInput={(e) => setName((e.currentTarget as HTMLInputElement).value.trim().toLowerCase())}
            />
            <button class="btn primary" disabled={!name}>
              Open
            </button>
          </form>
          <div class="hero-actions">
            <button class="btn lg" onClick={props.onConnect}>
              Deploy a site
            </button>
          </div>
        </div>

        <div class="hero-side">
          <div class="card deploy-card" aria-hidden="true">
            <div class="dc-head">
              <Logo size={36} />
              <div>
                <strong>{site}</strong>
                <span class="mono muted small">3.{site}</span>
              </div>
              <Badge tone="ok">
                <Icon name="check" size={12} /> Published
              </Badge>
            </div>
            <ol class="waypoints">
              <li>
                <i />v1
              </li>
              <li>
                <i />v2
              </li>
              <li class="now">
                <i />v3
              </li>
            </ol>
            <div class="dc-foot">
              <span>
                <Icon name="eth" size={15} /> Ethereum
              </span>
              <span>
                <Icon name="lock" size={15} /> Immutable
              </span>
              <span>
                <Icon name="globe" size={15} /> ENS
              </span>
            </div>
          </div>
          <code class="cli">
            <i>$</i> navik deploy portfolio ./index.html --promote
          </code>
        </div>
      </section>

      <section class="sea">
        <div class="waves" aria-hidden="true">
          <svg class="wave far" viewBox="0 0 800 96" preserveAspectRatio="none">
            <path d="M0 40Q100 8 200 40T400 40 600 40 800 40V96H0z" />
          </svg>
          <svg class="wave near" viewBox="0 0 800 96" preserveAspectRatio="none">
            <path d="M0 56Q100 24 200 56T400 56 600 56 800 56V96H0z" />
          </svg>
          <span class="boat">
            <Logo size={72} />
          </span>
          <svg class="wave front" viewBox="0 0 1200 96" preserveAspectRatio="none">
            <path d="M0 62C160 84 300 84 470 66S800 34 960 58 1120 80 1200 66V96H0z" />
          </svg>
        </div>
        <div class="deep">
          <div class="features">
            <div class="feature">
              <span class="feature-icon">
                <Icon name="layers" size={18} />
              </span>
              <div>
                <h3>Immutable</h3>
                <p>Every release is a contract.</p>
              </div>
            </div>
            <div class="feature">
              <span class="feature-icon">
                <Icon name="globe" size={18} />
              </span>
              <div>
                <h3>Versioned</h3>
                <p>Permanent names, instant rollback.</p>
              </div>
            </div>
            <div class="feature">
              <span class="feature-icon">
                <Icon name="shield" size={18} />
              </span>
              <div>
                <h3>Private</h3>
                <p>Reads go through a mixnet.</p>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}

function WrongChain(props: { chainId?: number; provider: WalletInfo; onError: (text: string) => void }) {
  return (
    <div class="empty">
      <h2>Navik is not deployed on chain {props.chainId}</h2>
      <div class="row center">
        {Object.keys(deployments).map((id) => (
          <button
            key={id}
            class="btn primary"
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
    <span class="root-status" title={`Nobody can repoint ${props.ctx.deployment.root}, including its owner`}>
      <Badge tone="ok">
        <Icon name="lock" size={12} /> Frozen
      </Badge>
    </span>
  ) : (
    <span class="root-status" title={`The ${props.ctx.deployment.root} owner can still repoint the namespace`}>
      <Badge tone="warn">Beta</Badge>
    </span>
  )
}

const rememberedKey = (ctx: navik.Ctx, account: Address) => `navik:projects:${ctx.deployment.chainId}:${account}`

function remember(ctx: navik.Ctx, account: Address, project: string) {
  const key = rememberedKey(ctx, account)
  store.set(key, [...new Set([...store.get<string[]>(key, []), project])])
}

function Projects(props: { ctx: navik.Ctx; account: Address }) {
  const { ctx, account } = props
  const [owned, setOwned] = useState<string[]>()
  const [filter, setFilter] = useState('')
  useEffect(() => {
    setOwned(undefined)
    navik.projectsOf(ctx, account).then(setOwned, () => setOwned([]))
  }, [ctx, account])

  const projects = [...new Set([...(owned ?? []), ...store.get<string[]>(rememberedKey(ctx, account), [])])]
    .filter((p) => p.includes(filter))
    .sort()

  return (
    <div class="page">
      <div class="page-head">
        <h1>Projects</h1>
        <div class="row">
          <label class="filter">
            <Icon name="search" />
            <input placeholder="Filter projects" value={filter} onInput={(e) => setFilter((e.currentTarget as HTMLInputElement).value.trim())} />
          </label>
          <a class="btn primary" href="#/new">
            <Icon name="plus" /> New project
          </a>
        </div>
      </div>
      {owned === undefined ? (
        <div class="grid">
          {[0, 1, 2].map((i) => (
            <div key={i} class="card project-card skeleton" />
          ))}
        </div>
      ) : projects.length === 0 ? (
        <div class="empty card">
          <span class="feature-icon">
            <Icon name="layers" size={20} />
          </span>
          <h2>{filter ? 'No matching projects' : 'No projects yet'}</h2>
          <a class="btn primary" href="#/new">
            <Icon name="plus" /> New project
          </a>
        </div>
      ) : (
        <div class="grid">
          {projects.map((p) => (
            <ProjectCard key={p} ctx={ctx} project={p} />
          ))}
        </div>
      )}
    </div>
  )
}

function ProjectCard(props: { ctx: navik.Ctx; project: string }) {
  const { ctx, project } = props
  const [s, setS] = useState<navik.ProjectSummary | null>()
  useEffect(() => {
    navik.projectSummary(ctx, project).then(setS, () => setS(null))
  }, [ctx, project])
  const name = navik.projectName(ctx, project)
  return (
    <a class="card project-card" href={`#/p/${project}`}>
      <div class="pc-head">
        <Avatar seed={name} size={32} />
        <div>
          <strong>{project}</strong>
          <div class="muted small">{name}</div>
        </div>
      </div>
      <div class="pc-foot">
        {s === undefined ? (
          <span class="muted small">
            <Spinner /> reading
          </span>
        ) : s === null ? (
          <span class="muted small">Could not read this project</span>
        ) : s.live ? (
          <span class="status">
            <i class="dot ok" /> Production · <Mono>{s.liveVersion ? `${s.liveVersion}.${project}` : shortAddr(s.live)}</Mono>
          </span>
        ) : (
          <span class="status muted">
            <i class="dot" /> {s.releases ? 'Not in production' : 'No releases yet'}
          </span>
        )}
        {s && <span class="muted small">{s.releases} release{s.releases === 1 ? '' : 's'}</span>}
      </div>
    </a>
  )
}

/** Claim a name, ENS style: type a label, see if it is available, claim it. */
function NewProject(props: { ctx: navik.Ctx; account: Address; run: Run; busy: boolean }) {
  const { ctx, account, run, busy } = props
  const [label, setLabel] = useState('')
  const [owner, setOwner] = useState<Address | null>()
  const [existing, setExisting] = useState('')
  const valid = navik.isValidProjectLabel(label)
  const root = ctx.deployment.root

  useEffect(() => {
    setOwner(undefined)
    if (!valid) return
    const t = setTimeout(() => {
      navik.projectOwner(ctx, label).then(
        (o) => setOwner(BigInt(o) === 0n ? null : o),
        () => setOwner(undefined),
      )
    }, 300)
    return () => clearTimeout(t)
  }, [ctx, label, valid])

  const available = valid && owner === null
  return (
    <div class="page narrow">
      <h1>
        Claim a name <Info>A permanent ENS name nobody can take back, including Navik. Every release gets a subname.</Info>
      </h1>
      <form
        class="card claim"
        onSubmit={async (e) => {
          e.preventDefault()
          if (!available) return
          const project = label
          if (await run(`Claiming ${project}.${root}`, () => navik.claim(ctx, project))) {
            remember(ctx, account, project)
            location.hash = `#/p/${project}`
          }
        }}
      >
        <div class={`name-field ${available ? 'ok' : owner ? 'taken' : ''}`}>
          <Avatar seed={`${label || 'navik'}.${root}`} size={28} />
          <input
            placeholder="my-site"
            value={label}
            aria-label="Project name"
            autoFocus
            onInput={(e) => setLabel((e.currentTarget as HTMLInputElement).value.trim().toLowerCase())}
          />
          <span class="suffix">.{root}</span>
        </div>
        <p class="small name-status">
          {!label ? null : !valid ? (
            <span class="error">3–63 of a–z, 0–9 and -, not starting or ending with -</span>
          ) : owner === undefined ? (
            <span class="muted">
              <Spinner /> Checking…
            </span>
          ) : owner === null ? (
            <span class="ok-text">
              <Icon name="check" size={14} /> Available
            </span>
          ) : (
            <span class="error">
              Taken by <Addr address={owner} chainId={ctx.deployment.chainId} />
              {owner.toLowerCase() === account.toLowerCase() && (
                <>
                  {' '}
                  (you): <a href={`#/p/${label}`}>open it</a>
                </>
              )}
            </span>
          )}
        </p>
        <button class="btn primary lg block" disabled={busy || !available}>
          {available ? `Claim ${label}.${root}` : 'Claim'}
        </button>
      </form>

      <form
        class="add-existing"
        onSubmit={(e) => {
          e.preventDefault()
          const project = existing.replace(new RegExp(`\\.${root.replace('.', '\\.')}$`), '')
          if (!navik.isValidProjectLabel(project)) return
          remember(ctx, account, project)
          location.hash = `#/p/${project}`
        }}
      >
        <label class="small muted" for="existing">
          Add a project you hold a key for
        </label>
        <div class="row">
          <input id="existing" placeholder="project name" value={existing} onInput={(e) => setExisting((e.currentTarget as HTMLInputElement).value.trim())} />
          <button class="btn">Add</button>
        </div>
      </form>
    </div>
  )
}

