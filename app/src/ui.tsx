import type { ComponentChildren } from 'preact'

export function shortAddr(a: string) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export function kb(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`
}

export function Card(props: { title: string; actions?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="card">
      <header>
        <h2>{props.title}</h2>
        {props.actions}
      </header>
      {props.children}
    </section>
  )
}

export function Badge(props: { tone?: 'ok' | 'warn' | 'muted'; children: ComponentChildren }) {
  return <span class={`badge ${props.tone ?? 'muted'}`}>{props.children}</span>
}

export function Mono(props: { children: ComponentChildren; title?: string }) {
  return (
    <code class="mono" title={props.title}>
      {props.children}
    </code>
  )
}
