/**
 * Optional gzip wrapping for releases. The stored document becomes a small loader page: the
 * original HTML, gzipped and base64-encoded, plus a script that decompresses it in the browser
 * (DecompressionStream) and swaps it in as the document. Standard formats on purpose: anyone can
 * audit a release with `base64 -d | gunzip`. The site then needs JavaScript to render.
 */

const MARKER = '/*navik:gzip:v1*/'
/**
 * The loader swaps in the decompressed document instead of using document.open/write, which
 * would erase every listener on `window`, including the ones wallets register for EIP-6963
 * discovery. Parsed scripts do not run, so each is re-created (in order, external ones awaited);
 * then DOMContentLoaded and load are dispatched for scripts that wait for them.
 */
const LOADER = (title: string, b64: string) =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><script>${MARKER}(async d=>{` +
  `const h=await new Response(new Blob([Uint8Array.from(atob("${b64}"),c=>c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream("gzip"))).text();` +
  `const n=new DOMParser().parseFromString(h,"text/html");d.replaceChild(d.adoptNode(n.documentElement),d.documentElement);` +
  `for(const o of[...d.querySelectorAll("script")]){const s=d.createElement("script");for(const a of o.attributes)s.setAttribute(a.name,a.value);` +
  `s.textContent=o.textContent;s.async=false;const w=s.src?new Promise(r=>{s.onload=s.onerror=r}):0;o.replaceWith(s);await w}` +
  `await new Promise(r=>setTimeout(r));d.dispatchEvent(new Event("DOMContentLoaded",{bubbles:true}));window.dispatchEvent(new Event("load"))` +
  `})(document)</script>`
const PAYLOAD = /\/\*navik:gzip:v1\*\/.*?atob\("([A-Za-z0-9+/=]*)"\)/s

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

/** Wraps an HTML document into a self-decompressing loader page. */
export async function wrapCompressed(html: Uint8Array): Promise<Uint8Array> {
  const text = new TextDecoder().decode(html)
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1]?.trim() ?? ''
  return new TextEncoder().encode(LOADER(title, toBase64(await gzip(html))))
}

/** The original document if `html` is a Navik gzip loader, otherwise undefined. */
export async function unwrapCompressed(html: Uint8Array): Promise<Uint8Array | undefined> {
  const m = PAYLOAD.exec(new TextDecoder().decode(html))
  return m ? gunzip(fromBase64(m[1])) : undefined
}
