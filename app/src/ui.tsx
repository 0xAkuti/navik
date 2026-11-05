import type { ComponentChildren } from 'preact'
import { useEffect } from 'preact/hooks'

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

/** ENS-style gradient avatar, derived from the name or address so it is stable everywhere. */
export function Avatar(props: { seed: string; size?: number }) {
  let h = 2166136261
  for (let i = 0; i < props.seed.length; i++) h = Math.imul(h ^ props.seed.charCodeAt(i), 16777619)
  const a = (h >>> 0) % 360
  const b = (a + 40 + ((h >>> 9) % 80)) % 360
  const s = props.size ?? 20
  return (
    <span
      class="avatar"
      style={{ width: `${s}px`, height: `${s}px`, background: `linear-gradient(135deg, hsl(${a} 85% 68%), hsl(${b} 80% 52%))` }}
    />
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

/** A name with its gradient avatar, as ENS shows names. */
export function Name(props: { name: string; size?: number }) {
  return (
    <span class="name">
      <Avatar seed={props.name} size={props.size} />
      <span>{props.name}</span>
    </span>
  )
}
