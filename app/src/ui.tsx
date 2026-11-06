import { generatePatternDataURI } from '@ensdomains/etherloom'
import type { Ctx } from '@navik/sdk'
import type { ComponentChildren } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import type { Address } from 'viem'
import { getEnsName } from 'viem/actions'

export function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export function kb(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

export function Badge(props: { tone?: 'ok' | 'warn' | 'blue' | 'muted'; children: ComponentChildren }) {
  return <span class={`badge ${props.tone ?? 'muted'}`}>{props.children}</span>
}

export function Mono(props: { children: ComponentChildren; title?: string }) {
  return (
    <code class="mono" title={props.title}>
      {props.children}
    </code>
  )
}

const ICONS = {
  plus: 'M12 5v14M5 12h14',
  arrow: 'M7 17 17 7M8 7h9v9',
  check: 'm5 12.5 4.5 4.5L19 7',
  x: 'M6 6l12 12M18 6 6 18',
  shield: 'M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3zm-3 9 2 2 4-4',
  upload: 'M12 15V4m0 0L8 8m4-4 4 4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  search: 'M17.5 17.5 21 21M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14z',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z',
  key: 'M14 10a4 4 0 1 0-3.5 4L8 16.5V19h2.5v-2h2l1.5-1.5V14a4 4 0 0 0 0-4zm1-1h.01',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  chevron: 'm9 6 6 6-6 6',
  copy: 'M9 8h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM5 16V5a1 1 0 0 1 1-1h10',
} as const

export function Icon(props: { name: keyof typeof ICONS; size?: number }) {
  const s = props.size ?? 16
  return (
    <svg class="icon" width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={ICONS[props.name]} />
    </svg>
  )
}

/** Navik's mark: a release stack pointing up, in ENS blue. */
export function Logo(props: { size?: number }) {
  const s = props.size ?? 22
  return (
    <svg width={s} height={s} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="9" fill="var(--accent)" />
      <path d="M9 19.5 16 12l7 7.5M9 24.5h14" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  )
}

const identicons = new Map<string, string>()

/**
 * The ENS app's identicon: an etherloom weave in ENS lapis, seeded by the name or address
 * exactly as the ENS manager seeds it, so a name looks the same here as it does there.
 */
export function Avatar(props: { seed: string; size?: number }) {
  const key = props.seed.toLowerCase()
  let src = identicons.get(key)
  if (!src) {
    src = generatePatternDataURI(key, 'ENS Vertical Pairs', '#0082BB', { cellSize: 10, width: 96, height: 96, padding: 10 })
    identicons.set(key, src)
  }
  const s = props.size ?? 20
  return <img class="avatar" src={src} alt="" width={s} height={s} draggable={false} />
}

/** Block explorer per chain; the dev fork is a mainnet fork, so it shares mainnet's. */
const BLOCKSCOUT: Record<number, string> = { 1: 'https://eth.blockscout.com', 31337: 'https://eth.blockscout.com' }

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const t = Object.assign(document.createElement('textarea'), { value: text })
    document.body.append(t)
    t.select()
    document.execCommand('copy')
    t.remove()
  }
}

export function CopyButton(props: { value: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])
  return (
    <button
      type="button"
      class={`copy-btn ${copied ? 'copied' : ''}`}
      title={copied ? 'Copied' : `Copy ${props.value}`}
      aria-label={copied ? 'Copied' : 'Copy'}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        copyText(props.value).then(() => setCopied(true), () => undefined)
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={13} />
    </button>
  )
}

/** An address: shortened unless `full`, linked to Blockscout unless `link` is false, with a copy button. */
export function Addr(props: { address: string; chainId?: number; full?: boolean; link?: boolean }) {
  const base = props.link === false ? undefined : BLOCKSCOUT[props.chainId ?? 1]
  const text = <Mono title={props.address}>{props.full ? props.address : shortAddr(props.address)}</Mono>
  return (
    <span class="hash">
      {base ? (
        <a class="ext" href={`${base}/address/${props.address}`} target="_blank" rel="noopener noreferrer" title={`${props.address} on Blockscout`}>
          {text}
        </a>
      ) : (
        text
      )}
      <CopyButton value={props.address} />
    </span>
  )
}

const primaryNames = new Map<string, Promise<string | undefined>>()

/** An address's primary ENS name (checked forward by the UniversalResolver), read like every other read; cached. */
export function primaryName(ctx: Ctx, address: Address): Promise<string | undefined> {
  const key = `${ctx.deployment.chainId}:${address.toLowerCase()}`
  let name = primaryNames.get(key)
  if (!name) {
    name = getEnsName(ctx.publicClient, { address, universalResolverAddress: ctx.deployment.universalResolver }).then(
      (n) => n ?? undefined,
      () => undefined,
    )
    primaryNames.set(key, name)
  }
  return name
}

/**
 * Someone, as ENS shows them: their primary name with its identicon if they have one, else the
 * address. Either way the address stays one hover, click (Blockscout) or copy away.
 */
export function Who(props: { ctx: Ctx; address: Address; chainId?: number; full?: boolean }) {
  const [name, setName] = useState<string>()
  useEffect(() => {
    setName(undefined)
    let cancelled = false
    primaryName(props.ctx, props.address).then((n) => !cancelled && setName(n))
    return () => {
      cancelled = true
    }
  }, [props.ctx, props.address])
  if (!name) return <Addr address={props.address} chainId={props.chainId} full={props.full} />
  const base = BLOCKSCOUT[props.chainId ?? 1]
  return (
    <span class="hash who" title={props.address}>
      <Avatar seed={name} size={16} />
      {base ? (
        <a class="ext" href={`${base}/address/${props.address}`} target="_blank" rel="noopener noreferrer">
          {name}
        </a>
      ) : (
        <span>{name}</span>
      )}
      <CopyButton value={props.address} />
    </span>
  )
}

/** A hash shown as its first `chars` characters, with a copy button for the whole value. */
export function Hash(props: { value: string; chars?: number }) {
  return (
    <span class="hash">
      <Mono title={props.value}>{props.value.slice(0, props.chars ?? 12)}…</Mono>
      <CopyButton value={props.value} />
    </span>
  )
}

export function Spinner() {
  return <span class="spinner" aria-label="loading" />
}

export function Modal(props: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])
  return (
    <div class="overlay" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-label={props.title}>
        <header>
          <h3>{props.title}</h3>
          <button class="icon-btn" onClick={props.onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        {props.children}
      </div>
    </div>
  )
}

/** A name with its identicon, as ENS shows names. */
export function Name(props: { name: string; size?: number }) {
  return (
    <span class="name">
      <Avatar seed={props.name} size={props.size} />
      <span>{props.name}</span>
    </span>
  )
}
