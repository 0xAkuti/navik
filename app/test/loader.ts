// Checks the gzip loader (sdk/src/compress.ts) in headless Chromium on a generic page.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { unwrapCompressed, wrapCompressed } from '@navik/sdk'
import { chromium } from 'playwright'

const original = `<!doctype html><html lang="en" data-site="demo"><head><title>Loader &amp; test</title>
<style>h1 { color: rgb(1, 2, 3) }</style>
<script>window.log = ['classic-head']</script>
</head><body><h1>Hello ${'x'.repeat(2000)}</h1>
<script>log.push('classic-body:' + !!document.querySelector('h1'))</script>
<script>document.addEventListener('DOMContentLoaded', () => log.push('dcl'))</script>
<script>window.addEventListener('load', () => log.push('load'))</script>
<script type="module">log.push('module')</script>
</body></html>`

const wrapped = await wrapCompressed(new TextEncoder().encode(original))
assert.ok(wrapped.length < original.length, 'compression pays off')
assert.equal(new TextDecoder().decode(await unwrapCompressed(wrapped)), original, 'round trip is exact')

const dir = mkdtempSync(join(tmpdir(), 'navik-loader-'))
const file = join(dir, 'index.html')
writeFileSync(file, wrapped)

const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  // like a wallet extension: a window listener registered before the page runs
  await page.addInitScript(() => {
    window.addEventListener('navik-test-ping', () => ((window as unknown as { pong: boolean }).pong = true))
  })
  await page.goto(pathToFileURL(file).href)
  await page.waitForFunction(() => (window as unknown as { log?: string[] }).log?.includes('load'))

  const log = await page.evaluate(() => (window as unknown as { log: string[] }).log)
  assert.deepEqual(log.slice(0, 2), ['classic-head', 'classic-body:true'], 'classic scripts run in order with the DOM present')
  for (const entry of ['module', 'dcl', 'load']) assert.ok(log.includes(entry), `${entry} ran (log: ${log})`)

  assert.equal(await page.title(), 'Loader & test')
  assert.equal(await page.getAttribute('html', 'data-site'), 'demo')
  assert.equal(await page.locator('h1').evaluate((h) => getComputedStyle(h).color), 'rgb(1, 2, 3)')

  const pong = await page.evaluate(() => {
    window.dispatchEvent(new Event('navik-test-ping'))
    return (window as unknown as { pong?: boolean }).pong
  })
  assert.equal(pong, true, 'window listeners registered before the loader survive')
  console.log('loader checks passed')
} finally {
  await browser.close()
}
