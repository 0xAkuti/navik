// The segmented layout (compress.ts): large inlined assets get chunk-aligned segments of their own,
// so they are identical across releases whatever else changes, and unwrapping is exact.
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { test } from 'node:test'

import { storedLayout, unwrapCompressed, wrapCompressed } from '../src/compress.ts'
import { packSite, type SiteFiles } from '../src/pack.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const font = new Uint8Array(randomBytes(30_000)) // incompressible, like woff2
const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<circle r="1"/>'.repeat(600)}</svg>` // compressible

const build = (app: string): SiteFiles => ({
  'index.html': enc('<!doctype html><title>Seg</title><link rel="stylesheet" href="/assets/i.css"><script type="module" src="/assets/i.js"></script><img src="/assets/bg.svg">'),
  'assets/i.css': enc('@font-face{font-family:F;src:url(./f.woff2)}body{font-family:F}'),
  'assets/i.js': enc(`document.body.dataset.app=${JSON.stringify(app)}`),
  'assets/f.woff2': font,
  'assets/bg.svg': enc(svg),
  'assets/tiny.png': new Uint8Array(10),
})

/** Splits a layout into chunks the way planPublish does. */
function chunks({ bytes, regions }: { bytes: Uint8Array; regions: number[] }, size = 24_575): string[] {
  const out: string[] = []
  let start = 0
  for (const len of regions) {
    for (let i = start; i < start + len; i += size) out.push(Buffer.from(bytes.subarray(i, Math.min(i + size, start + len))).toString('hex'))
    start += len
  }
  return out
}

test('large assets get segments of their own; the document comes back exactly', async () => {
  const pack = packSite(build('v1'))
  const layout = await storedLayout(pack.html, { compress: true, assets: pack.assets })
  assert.equal(layout.segments, 2, 'the font and the SVG, not the tiny file')
  assert.equal(layout.regions.length, 4, 'head, two assets, document')
  assert.equal(layout.regions.reduce((a, b) => a + b, 0), layout.bytes.length)
  assert.deepEqual(await unwrapCompressed(layout.bytes), pack.html)
  const text = new TextDecoder().decode(layout.bytes)
  assert.match(text, /^<!doctype html><meta charset="utf-8"><title>Seg<\/title><script type="navik\/asset"/)
  assert.match(text, /data-type="image\/svg\+xml" data-gz>/, 'text assets are gzipped')
  assert.match(text, /data-type="font\/woff2">/, 'compressed formats are stored as they are')
})

test("a change to the app leaves the assets' chunks as they were", async () => {
  const [a, b] = [packSite(build('v1')), packSite(build('v2'))]
  const [la, lb] = await Promise.all([a, b].map((p) => storedLayout(p.html, { compress: true, assets: p.assets })))
  const before = new Set(chunks(la))
  const after = chunks(lb)
  // head (same title) + font (2 chunks) + SVG are reused; only the document's chunk is new
  assert.equal(after.filter((c) => before.has(c)).length, after.length - 1)
})

test('without large assets, or uncompressed, the layout is unchanged', async () => {
  const html = enc('<!doctype html><title>x</title><p>hi')
  assert.deepEqual((await storedLayout(html, { compress: true, assets: [] })).bytes, await wrapCompressed(html))
  assert.deepEqual(await storedLayout(html), { bytes: html, regions: [html.length], segments: 0 })
})
