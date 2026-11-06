/**
 * Optional gzip wrapping for releases. The stored document becomes a small loader page: the
 * original HTML, gzipped and base64-encoded, plus a script that decompresses it in the browser
 * (DecompressionStream) and swaps it in as the document. Standard formats on purpose: anyone can
 * audit a release with `base64 -d | gunzip`. The site then needs JavaScript to render.
 *
 * A packed build (pack.ts) can instead be stored segmented: each large file it inlined as a data
 * URI (fonts, images, …) in segments of its own, and the document, with placeholders where those
 * data URIs were, last. Every segment starts a new chunk, and a file's segment depends only on
 * its bytes, so an unchanged font or image is stored once, across releases and projects, however
 * the rest of the site changes. Unwrapping (and the loader) rebuild the packed document exactly.
 */
import { keccak256, toBytes } from 'viem'

const MARKER = '/*navik:gzip:v1*/'
/**
 * The loader swaps in the decompressed document instead of using document.open/write, which
 * would erase every listener on `window`, including the ones wallets register for EIP-6963
 * discovery. Parsed scripts do not run, so each is re-created (in order, external ones awaited);
 * then DOMContentLoaded and load are dispatched for scripts that wait for them.
 */
const SWAP =
  `const n=new DOMParser().parseFromString(h,"text/html");d.replaceChild(d.adoptNode(n.documentElement),d.documentElement);` +
  `for(const o of[...d.querySelectorAll("script")]){const s=d.createElement("script");for(const a of o.attributes)s.setAttribute(a.name,a.value);` +
  `s.textContent=o.textContent;s.async=false;const w=s.src?new Promise(r=>{s.onload=s.onerror=r}):0;o.replaceWith(s);await w}` +
  `await new Promise(r=>setTimeout(r));d.dispatchEvent(new Event("DOMContentLoaded",{bubbles:true}));window.dispatchEvent(new Event("load"))`
const head = (title: string) => `<!doctype html><meta charset="utf-8"><title>${title}</title>`
const LOADER = (title: string, b64: string) =>
  `${head(title)}<script>${MARKER}(async d=>{` +
  `const h=await new Response(new Blob([Uint8Array.from(atob("${b64}"),c=>c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream("gzip"))).text();` +
  SWAP +
  `})(document)</script>`
const PAYLOAD = /\/\*navik:gzip:v1\*\/.*?atob\("([A-Za-z0-9+/=]*)"\)/s

const SEGMENTS_MARKER = '/*navik:segments:v1*/'
/** Where a segmented asset's data URI was in the document. */
const PLACEHOLDER = /navik-asset:([0-9a-f]{16})/g
const assetElement = (key: string, type: string, gz: boolean, b64: string) =>
  `<script type="navik/asset" data-k="${key}" data-type="${type}"${gz ? ' data-gz' : ''}>${b64}</script>`
const ASSET = /<script type="navik\/asset" data-k="([0-9a-f]{16})" data-type="([^"]*)"( data-gz)?>([A-Za-z0-9+/=]*)<\/script>/g
/** Runs after the asset elements are parsed: rebuilds their data URIs, then the document, then swaps it in like LOADER. */
const SEGMENTS_LOADER = (b64: string) =>
  `<script>${SEGMENTS_MARKER}(async d=>{` +
  `const z=async b=>new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer()),` +
  `u=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0)),` +
  `e=b=>{let s="";for(let i=0;i<b.length;i+=32768)s+=String.fromCharCode(...b.subarray(i,i+32768));return btoa(s)},m={};` +
  `for(const s of d.querySelectorAll('script[type="navik/asset"]')){const b=u(s.textContent);` +
  `m[s.dataset.k]="data:"+s.dataset.type+";base64,"+e(s.hasAttribute("data-gz")?await z(b):b)}` +
  `const h=new TextDecoder().decode(await z(u("${b64}"))).replace(/navik-asset:([0-9a-f]{16})/g,(x,k)=>m[k]??x);` +
  SWAP +
  `})(document)</script>`
const SEGMENTS_PAYLOAD = /\/\*navik:segments:v1\*\/.*?z\(u\("([A-Za-z0-9+/=]*)"\)\)/s
/** Smaller files are not worth a chunk of their own. */
const MIN_SEGMENT = 4096

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream)
  return new Uint8Array(await new Response(out).arrayBuffer())
}

export const gzip = (bytes: Uint8Array) => pipe(bytes, new CompressionStream('gzip'))
export const gunzip = (bytes: Uint8Array) => pipe(bytes, new DecompressionStream('gzip'))

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

const titleOf = (text: string) => /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() ?? ''

/** Wraps an HTML document into a self-decompressing loader page. */
export async function wrapCompressed(html: Uint8Array): Promise<Uint8Array> {
  return new TextEncoder().encode(LOADER(titleOf(new TextDecoder().decode(html)), toBase64(await gzip(html))))
}

/** A file inlined into the document as `data:${type};base64,…` (see PackedAsset). */
export type InlinedAsset = { type: string; bytes: Uint8Array }

/** Stored bytes, and the lengths of the regions they are made of: each region starts a new chunk. */
export type StoredLayout = { bytes: Uint8Array; regions: number[]; segments: number }

/**
 * The bytes a release stores for `html`: as is, gzip-wrapped, or (when compressing a document with
 * large inlined assets) segmented, so those assets get chunks of their own.
 */
export async function storedLayout(html: Uint8Array, opts: { compress?: boolean; assets?: InlinedAsset[] } = {}): Promise<StoredLayout> {
  if (!opts.compress) return { bytes: html, regions: [html.length], segments: 0 }
  const segmented = opts.assets?.length ? await wrapSegmented(html, opts.assets) : undefined
  if (segmented) return segmented
  const bytes = await wrapCompressed(html)
  return { bytes, regions: [bytes.length], segments: 0 }
}

async function wrapSegmented(html: Uint8Array, assets: InlinedAsset[]): Promise<StoredLayout | undefined> {
  let text = new TextDecoder().decode(html)
  if (text.includes('navik-asset:')) return undefined
  const regions = [head(titleOf(text))]
  const seen = new Set<string>()
  // longest first, so a data URI that happens to start another one is not cut out of it
  const uris = assets
    .filter((a) => a.bytes.length >= MIN_SEGMENT)
    .map((a) => ({ ...a, uri: `data:${a.type};base64,${toBase64(a.bytes)}` }))
    .sort((a, b) => b.uri.length - a.uri.length)
  for (const a of uris) {
    const key = keccak256(toBytes(a.uri)).slice(2, 18)
    if (seen.has(key) || !text.includes(a.uri)) continue
    seen.add(key)
    text = text.split(a.uri).join(`navik-asset:${key}`)
    const gz = await gzip(a.bytes)
    // already-compressed formats (woff2, png, jpeg) are stored as they are
    const packed = gz.length < a.bytes.length * 0.9
    regions.push(assetElement(key, a.type, packed, toBase64(packed ? gz : a.bytes)))
  }
  if (seen.size === 0) return undefined
  regions.push(SEGMENTS_LOADER(toBase64(await gzip(new TextEncoder().encode(text)))))
  const parts = regions.map((r) => new TextEncoder().encode(r))
  const bytes = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    bytes.set(p, at)
    at += p.length
  }
  return { bytes, regions: parts.map((p) => p.length), segments: seen.size }
}

/** The original document if `html` is a Navik gzip loader (plain or segmented), otherwise undefined. */
export async function unwrapCompressed(html: Uint8Array): Promise<Uint8Array | undefined> {
  const text = new TextDecoder().decode(html)
  const m = PAYLOAD.exec(text)
  if (m) return gunzip(fromBase64(m[1]))
  const seg = SEGMENTS_PAYLOAD.exec(text)
  if (!seg) return undefined
  const uris = new Map<string, string>()
  for (const [, key, type, gz, b64] of text.matchAll(ASSET)) {
    const bytes = gz ? await gunzip(fromBase64(b64)) : fromBase64(b64)
    uris.set(key, `data:${type};base64,${toBase64(bytes)}`)
  }
  const doc = new TextDecoder().decode(await gunzip(fromBase64(seg[1])))
  return new TextEncoder().encode(doc.replace(PLACEHOLDER, (x, key: string) => uris.get(key) ?? x))
}
