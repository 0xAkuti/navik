// packSite on build directories shaped like Vite's output: everything referenced ends up in the
// one document, code splitting is rejected, and the result is deterministic.
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { PackError, packSite, type SiteFiles } from '../src/pack.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
const b64 = (s: string) => Buffer.from(s).toString('base64')
const site = (files: Record<string, string | Uint8Array>): SiteFiles =>
  Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? enc(v) : v]))

const vite = () =>
  site({
    'index.html':
      '<!doctype html><html><head><link rel="icon" type="image/svg+xml" href="/favicon.svg">' +
      '<script type="module" crossorigin src="/assets/index-Abc123.js"></script>' +
      '<link rel="stylesheet" crossorigin href="/assets/index-Def456.css"></head>' +
      '<body><div id="root"></div><img src="./assets/hero-1a2b.png" alt=""></body></html>',
    'assets/index-Abc123.js': 'const logo="/assets/logo-9f8e.svg";const s="</script>";document.title=logo\n//# sourceMappingURL=index-Abc123.js.map',
    'assets/index-Abc123.js.map': '{}',
    'assets/index-Def456.css': '@font-face{src:url(/assets/inter-77.woff2) format("woff2")}body{background:url("./bg-55.png")}',
    'assets/logo-9f8e.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
    'assets/inter-77.woff2': new Uint8Array([1, 2, 3]),
    'assets/bg-55.png': new Uint8Array([4, 5]),
    'assets/hero-1a2b.png': new Uint8Array([6]),
    'favicon.svg': '<svg/>',
    'robots.txt': 'User-agent: *',
    '.vite/manifest.json': '{}',
  })

test('inlines scripts, styles and every referenced asset', () => {
  const { html, inlined, unused } = packSite(vite())
  const out = dec(html)
  assert.match(out, /<script type="module">const logo="data:image\/svg\+xml;base64,/)
  assert.ok(!out.includes('crossorigin'))
  assert.ok(out.includes('const s="<\\/script>"'), 'a closing tag inside the script is escaped')
  assert.ok(!out.includes('sourceMappingURL'))
  assert.match(out, /<style>@font-face\{src:url\(data:font\/woff2;base64,AQID\) format/)
  assert.ok(out.includes(`url("data:image/png;base64,${Buffer.from([4, 5]).toString('base64')}")`), 'CSS url relative to the stylesheet')
  assert.ok(out.includes(`href="data:image/svg+xml;base64,${b64('<svg/>')}"`), 'favicon from public/')
  assert.ok(out.includes(`<img src="data:image/png;base64,${Buffer.from([6]).toString('base64')}"`))
  assert.ok(!/assets\//.test(out), 'no URL into the build is left')
  assert.deepEqual(unused, ['robots.txt'])
  assert.equal(inlined.length, 7)
})

test('is deterministic', () => {
  assert.deepEqual(packSite(vite()).html, packSite(vite()).html)
})

test('rejects code splitting', () => {
  const files = vite()
  files['assets/index-Abc123.js'] = enc('const m=()=>import("./Page-x1.js");export{m}')
  files['assets/Page-x1.js'] = enc('export default 1')
  assert.throws(() => packSite(files), (e: unknown) => e instanceof PackError && /codeSplitting = false/.test(e.message))
})

test('rejects preloaded chunks', () => {
  const files = vite()
  files['index.html'] = enc(`${dec(files['index.html'])}<link rel="modulepreload" href="/assets/vendor-q.js">`)
  files['assets/vendor-q.js'] = enc('export{}')
  assert.throws(() => packSite(files), /preloads assets\/vendor-q\.js/)
})

test('leaves external and unknown URLs alone', () => {
  const out = dec(
    packSite(site({ 'index.html': '<script src="https://cdn.example/x.js"></script><a href="/about">x</a><img src="/missing.png">' })).html,
  )
  assert.equal(out, '<script src="https://cdn.example/x.js"></script><a href="/about">x</a><img src="/missing.png">')
})

test('needs an index.html', () => {
  assert.throws(() => packSite(site({ 'main.js': '' })), /no index\.html/)
})
