/**
 * Loads a site the way the Navik viewer shows it, in a sandboxed frame with an opaque origin and
 * no URLs of its own, and reports what broke: uncaught errors, requests for files that are not
 * part of the document, or an empty page. Uses Playwright's Chromium when it is installed.
 */

export type SmokeReport = {
  ok: boolean
  /** uncaught exceptions */
  errors: string[]
  /** relative URLs the site requested: files that did not make it into the document */
  missing: string[]
  /** console.error output (reported, not fatal: e.g. a public RPC rate-limiting the test) */
  consoleErrors: string[]
  /** hosts the site contacted */
  hosts: string[]
  rendered: boolean
  title: string
}

// the frame inherits this page's URL as its base, so a relative request shows up under it
const HOST = 'http://navik-smoke.invalid/'
const SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals'

export async function smoke(html: Uint8Array, waitMs = 2000): Promise<SmokeReport> {
  let chromium: typeof import('playwright').chromium
  try {
    ;({ chromium } = await import('playwright'))
  } catch {
    throw new Error('--smoke needs Playwright: `npm i -D playwright && npx playwright install chromium`')
  }
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    const missing: string[] = []
    const consoleErrors: string[] = []
    const hosts = new Set<string>()
    page.on('pageerror', (e) => errors.push(e.message))
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    await page.route('**/*', (route) => {
      const url = route.request().url()
      if (url === HOST) {
        return route.fulfill({ contentType: 'text/html', body: `<!doctype html><style>body{margin:0}iframe{border:0;width:100vw;height:100vh}</style><iframe sandbox="${SANDBOX}"></iframe>` })
      }
      if (url.startsWith(HOST)) {
        missing.push(`/${url.slice(HOST.length)}`)
        return route.abort()
      }
      if (/^https?:/.test(url)) hosts.add(new URL(url).host)
      return route.continue()
    })
    await page.goto(HOST)
    await page.evaluate(
      (doc) =>
        new Promise<void>((done) => {
          const frame = document.querySelector('iframe')!
          frame.onload = () => done()
          frame.srcdoc = doc
        }),
      new TextDecoder().decode(html),
    )
    await page.waitForTimeout(waitMs)
    const frame = page.frames().find((f) => f !== page.mainFrame())!
    const { rendered, title } = await frame.evaluate(() => {
      const visible = [...document.body.querySelectorAll('*')].some((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0
      })
      return { rendered: visible || document.body.innerText.trim().length > 0, title: document.title }
    })
    return {
      ok: errors.length === 0 && missing.length === 0 && rendered,
      errors,
      missing,
      consoleErrors,
      hosts: [...hosts].sort(),
      rendered,
      title,
    }
  } finally {
    await browser.close()
  }
}

export function describeSmoke(r: SmokeReport): string[] {
  const title = r.title ? ` ("${r.title}")` : ''
  const lines = [`smoke        ${r.ok ? `✓ rendered in a sandboxed frame${title}` : `✗ broke in a sandboxed frame${title}`}`]
  if (!r.rendered) lines.push('  ✗ the page rendered nothing')
  for (const e of r.errors) lines.push(`  ✗ uncaught: ${e}`)
  for (const m of r.missing) lines.push(`  ✗ requested ${m}, which is not in the document`)
  for (const e of r.consoleErrors) lines.push(`  ⚠ console: ${e.slice(0, 200)}`)
  if (r.hosts.length) lines.push(`  contacted    ${r.hosts.join(', ')}`)
  return lines
}
