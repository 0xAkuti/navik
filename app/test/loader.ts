// Checks the gzip loader (sdk/src/compress.ts) in headless Chromium on a generic page, plain and
// segmented (a large inlined asset stored in a segment of its own).
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { storedLayout, unwrapCompressed, wrapCompressed } from '@navik/sdk'
import { chromium } from 'playwright'

// an image big enough to get a segment of its own
const svg = new TextEncoder().encode(
  `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30">${'<rect width="1" height="1"/>'.repeat(300)}</svg>`,
)
const svgUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
const original = `<!doctype html><html lang="en" data-site="demo"><head><title>Loader &amp; test</title>
<style>h1 { color: rgb(1, 2, 3) } body { background: url("${svgUri}") }</style>
<script>window.log = ['classic-head']</script>
</head><body><h1>Hello ${'x'.repeat(2000)}</h1><img id="pic" src="${svgUri}">
<script>log.push('classic-body:' + !!document.querySelector('h1'))</script>
<script>document.addEventListener('DOMContentLoaded', () => log.push('dcl'))</script>
<script>window.addEventListener('load', () => log.push('load'))</script>
<script type="module">log.push('module')</script>
</body></html>`

const plain = await wrapCompressed(new TextEncoder().encode(original))
assert.ok(plain.length < original.length, 'compression pays off')
const segmented = await storedLayout(new TextEncoder().encode(original), {
  compress: true,
  assets: [{ type: 'image/svg+xml', bytes: svg }],
})
assert.equal(segmented.segments, 1, 'the image is stored in a segment of its own')

const dir = mkdtempSync(join(tmpdir(), 'navik-loader-'))
const browser = await chromium.launch()
try {
  for (const [label, wrapped] of [['plain', plain], ['segmented', segmented.bytes]] as const) {
    assert.equal(new TextDecoder().decode(await unwrapCompressed(wrapped)), original, `${label}: round trip is exact`)
    const file = join(dir, `${label}.html`)
    writeFileSync(file, wrapped)
    await check(file, label)
  }
  console.log('loader checks passed (plain and segmented)')
} finally {
  await browser.close()
}

async function check(file: string, label: string) {
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
  assert.equal(pong, true, `${label}: window listeners registered before the loader survive`)
  assert.equal(await page.locator('#pic').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), 40, `${label}: the image renders`)
  assert.match(await page.evaluate(() => getComputedStyle(document.body).backgroundImage), /^url\("data:image\/svg\+xml;base64,/)
  await page.close()
}
