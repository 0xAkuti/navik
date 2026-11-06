/**
 * Anonymized reads for the CLI. Anon-rpc has no published Node harness, and the Nym and Nox workers
 * need WebAssembly, Worker and WebSocket, so the worker runs where it was built to run: a headless
 * Chromium, in the harness's null-origin sandbox, hash-checked against the pin in @navik/sdk. Keys
 * stay in this process: transactions are signed here, and the browser only ever sees requests.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type AnonNetwork, ANON_TRANSPORT, defaultSettings, networkById, type NetworkId, pinnedAnswers } from '@navik/sdk'
import type { Browser, Page } from 'playwright'
import { http, keccak256, type Transport } from 'viem'

import type { AnonRequest, AnonResponse, AnonStart } from './anon-page.ts'
import { loadPlaywright } from './playwright.ts'

/** Set by bundle.ts; from source, anon-build.ts builds it on demand. */
declare const __NAVIK_ANON_PAGE__: string | undefined

type Bridge = { navikAnon: { start(s: AnonStart): Promise<void>; send(id: string, r: AnonRequest): Promise<AnonResponse> } }

// https: the workers' crypto needs a secure context. Served by Playwright, never requested.
const ORIGIN = 'https://navik-anon.invalid/'
const CONNECT_TIMEOUT = 90_000
const WORKER_CACHE = join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'navik', 'anon-rpc')
/** One per run: asks the network to keep separate runs unlinkable (support is per network). */
const ISOLATION_KEY = randomUUID()

let browser: Browser | undefined
let opening: Promise<Page> | undefined
const started = new Map<AnonNetwork['id'], Promise<void>>()
const calls = new Map<string, number>()

async function pageScript(): Promise<string> {
  if (typeof __NAVIK_ANON_PAGE__ !== 'undefined') return __NAVIK_ANON_PAGE__
  const dev = new URL('./anon-build.ts', import.meta.url).href // not bundled: only for runs from source
  return ((await import(dev)) as typeof import('./anon-build.ts')).buildAnonPage()
}

async function openPage(local: boolean): Promise<Page> {
  const { chromium } = await loadPlaywright('--anon')
  const script = await pageScript()
  // Chromium keeps public pages off loopback; only the passthrough worker, on a fork, needs it
  browser = await chromium.launch({ args: local ? ['--disable-features=LocalNetworkAccessChecks'] : [] })
  const page = await browser.newPage()
  await page.route(ORIGIN, (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }))
  await page.goto(ORIGIN)
  await page.addScriptTag({ content: script })
  return page
}

/** Each run gets a new browser, so without this the worker CDN would see every run. */
async function cacheWorker(page: Page, n: AnonNetwork) {
  mkdirSync(WORKER_CACHE, { recursive: true })
  const file = join(WORKER_CACHE, `${n.workerHash}.js`)
  await page.route(
    (url) => n.resolvers.includes(url.href),
    async (route) => {
      const headers = { 'access-control-allow-origin': '*', 'content-type': 'text/javascript' }
      if (existsSync(file)) return route.fulfill({ headers, body: readFileSync(file) })
      const res = await route.fetch()
      const body = await res.body()
      // the harness checks the hash anyway; this keeps a bad response out of the cache
      if (res.ok() && keccak256(body) === n.workerHash) writeFileSync(file, body)
      return route.fulfill({ response: res, headers: { ...res.headers(), ...headers }, body })
    },
  )
}

function start(n: AnonNetwork): Promise<void> {
  const running = started.get(n.id)
  if (running) return running
  const connecting = (async () => {
    opening ??= openPage(!n.anonymous)
    const page = await opening
    await cacheWorker(page, n)
    const spec: AnonStart = { id: n.id, specifier: n.specifier, config: n.config, answers: pinnedAnswers(n) }
    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${n.name} did not connect within ${CONNECT_TIMEOUT / 1000} s`)), CONNECT_TIMEOUT)
    })
    try {
      await Promise.race([page.evaluate((s) => (globalThis as unknown as Bridge).navikAnon.start(s), spec), timeout])
    } finally {
      clearTimeout(timer)
    }
    console.error(`anon-rpc     connected to ${n.name}${n.anonymous ? '' : ' (NOT anonymous: a reference worker for local testing)'}`)
  })()
  started.set(n.id, connecting)
  return connecting
}

const countCalls = (body: unknown) => {
  try {
    const json = JSON.parse(String(body))
    return Array.isArray(json) ? json.length : 1
  } catch {
    return 1
  }
}

function anonFetch(n: AnonNetwork): typeof fetch {
  return async (url, init) => {
    await start(n)
    const page = await opening!
    const request: AnonRequest = {
      url: String(url),
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: init?.body === undefined ? undefined : String(init.body),
      isolationKey: ISOLATION_KEY,
    }
    calls.set(n.name, (calls.get(n.name) ?? 0) + countCalls(init?.body))
    const res = await page.evaluate(([id, r]) => (globalThis as unknown as Bridge).navikAnon.send(id, r), [n.id, request] as const)
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers })
  }
}

/** `http()` through `network`; the browser starts on the first request. */
export function anonTransport(rpc: string, network: AnonNetwork): Transport {
  return http(rpc, { ...ANON_TRANSPORT, fetchFn: anonFetch(network) })
}

const isLocal = (rpc: string) => /^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(new URL(rpc).host)

/** `--anon` / `--anon-network` / NAVIK_ANON → the network for chain reads, if any. */
export function anonNetwork(rpc: string, id: NetworkId): AnonNetwork {
  const n = networkById(id)
  if (!n) throw new Error(`unknown anon-rpc network "${id}"`)
  if (n.anonymous && isLocal(rpc)) {
    throw new Error(`no ${n.name} exit can reach ${new URL(rpc).host}: pass a public --rpc, or --anon-network passthrough to test locally`)
  }
  return n
}

/** Arkiv's reads use Nox, or passthrough when testing (see UNSUPPORTED in @navik/sdk). */
export function anonArkivNetwork(main: AnonNetwork, chainId: number): AnonNetwork {
  return main.anonymous ? networkById(defaultSettings(chainId).network)! : main
}

export async function closeAnon() {
  if (!browser) return
  await browser.close().catch(() => {})
  browser = undefined
  for (const [name, count] of calls) console.error(`anon-rpc     ${count} call${count === 1 ? '' : 's'} through ${name}`)
}
