/**
 * Packs a static build directory (e.g. Vite's `dist/`) into the single HTML document a release
 * stores. An onchain site has no other URLs, so every file the page references is inlined:
 * scripts and stylesheets into the document, everything else (images, fonts, icons, JSON) as data
 * URIs wherever it is referenced (HTML attributes, CSS `url()`, string literals in JS). The output
 * depends only on the input files, so a rebuild of the same source packs to the same bytes.
 *
 * What cannot be inlined is an error, not a broken site: a JS file referenced from another JS file
 * means code splitting (module chunks import each other by URL), which needs to be turned off in
 * the bundler.
 */

export type SiteFiles = Record<string, Uint8Array>

export type PackResult = {
  html: Uint8Array
  /** files inlined into the document, in the order they were first used */
  inlined: string[]
  /** files in the build that nothing references; they are not part of the release */
  unused: string[]
}

export class PackError extends Error {
  readonly problems: string[]
  constructor(problems: string[]) {
    super(`cannot pack this build into one document:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'PackError'
    this.problems = problems
  }
}

/** Recorded as a release's `output` when it was packed from a directory: `dist` → `dist/`. */
export const isPackedOutput = (output: string) => output.endsWith('/')

const MIME: Record<string, string> = {
  html: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  css: 'text/css',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  map: 'application/json',
  txt: 'text/plain',
  xml: 'application/xml',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  webm: 'video/webm',
}
/** Text formats whose own references are resolved before they are inlined. */
const TEXT = new Set(['html', 'js', 'mjs', 'css', 'json', 'webmanifest', 'svg'])
const JS = new Set(['js', 'mjs'])
/** Build metadata that is never part of a site. */
const IGNORED = /(^|\/)(\.vite\/|\.DS_Store$)|\.map$/

const SPLIT_HINT =
  'chunks load each other by URL, which an onchain site does not have: bundle into one script ' +
  '(Vite 8: build.rolldownOptions.output.codeSplitting = false; Vite 7: build.rollupOptions.output.inlineDynamicImports = true)'

const ext = (path: string) => /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? ''
const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1)
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const utf8 = new TextDecoder()

function normalize(path: string): string | undefined {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length === 0) return undefined
      out.pop()
    } else out.push(part)
  }
  return out.join('/')
}

function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

/** Drops `//# sourceMappingURL=` comments: the maps are not shipped, and the URLs would not resolve. */
const stripSourceMaps = (code: string) => code.replace(/\n?\/[/*][#@] sourceMappingURL=[^\s*]+(\s*\*\/)?/g, '')

export function packSite(files: SiteFiles, entry = 'index.html'): PackResult {
  const paths = Object.keys(files).sort()
  if (!files[entry]) throw new PackError([`no ${entry} in the build (files: ${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ', …' : ''})`])
  const problems: string[] = []
  const inlined: string[] = []
  const used = new Set<string>([entry])
  const uris = new Map<string, string>()
  const resolving: string[] = []

  /** The build file `ref` (as written inside `from`) points to, if any. */
  function resolve(ref: string, from: string): string | undefined {
    const clean = ref.replace(/[?#].*$/, '')
    if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return undefined
    const candidates = clean.startsWith('/') ? [clean] : [dirOf(from) + clean, clean]
    for (const c of candidates) {
      const p = normalize(c)
      if (p !== undefined && files[p] && !IGNORED.test(p)) return p
    }
    return undefined
  }

  /** Every spelling under which `from` may reference `path`: `/a/b.png`, `./b.png`, `a/b.png`, … */
  function spellings(path: string, from: string): string[] {
    const s = new Set([`/${path}`, `./${path}`, path])
    const dir = dirOf(from)
    if (dir && path.startsWith(dir)) {
      s.add(path.slice(dir.length))
      s.add(`./${path.slice(dir.length)}`)
    }
    if (dir && !path.startsWith(dir)) s.add(`${'../'.repeat(dir.split('/').length - 1)}${path}`)
    return [...s].sort((a, b) => b.length - a.length)
  }

  /**
   * Replaces references to build files inside `text` (the content of `from`). A reference is a
   * path that names an existing build file, delimited like a string literal, a CSS `url()` or an
   * HTML attribute value, so prose that merely mentions a path does not match.
   */
  function inlineRefs(text: string, from: string): string {
    const isJs = JS.has(ext(from))
    const before = ext(from) === 'html' ? `["'(=\\s,]` : `["'\`(]`
    const after = ext(from) === 'html' ? `["')\\s,>]` : `["'\`)]`
    for (const path of paths) {
      if (path === from || IGNORED.test(path) || path === entry) continue
      if (!text.includes(path.slice(path.lastIndexOf('/') + 1))) continue
      const alts = spellings(path, from).map(escapeRe).join('|')
      const re = new RegExp(`(${before}\\s*)(?:${alts})([?#][^"'\`()\\s]*)?(?=\\s*${after})`, 'g')
      text = text.replace(re, (_m, open: string, suffix?: string) => {
        if (isJs && JS.has(ext(path))) {
          problems.push(`${from} loads ${path} by URL (a code-split chunk)`)
          return _m
        }
        return open + dataUri(path) + (suffix?.startsWith('#') ? suffix : '')
      })
    }
    return text
  }

  function content(path: string): string {
    if (resolving.includes(path)) {
      problems.push(`circular reference: ${[...resolving, path].join(' → ')}`)
      return ''
    }
    resolving.push(path)
    try {
      let text = utf8.decode(files[path])
      if (JS.has(ext(path)) || ext(path) === 'css') text = stripSourceMaps(text)
      return inlineRefs(text, path)
    } finally {
      resolving.pop()
    }
  }

  function use(path: string) {
    if (!used.has(path)) {
      used.add(path)
      inlined.push(path)
    }
  }

  function dataUri(path: string): string {
    use(path)
    let uri = uris.get(path)
    if (!uri) {
      const type = MIME[ext(path)] ?? 'application/octet-stream'
      const bytes = TEXT.has(ext(path)) ? new TextEncoder().encode(content(path)) : files[path]
      uri = `data:${type};base64,${toBase64(bytes)}`
      uris.set(path, uri)
    }
    return uri
  }

  const attr = (tag: string, name: string) =>
    new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag)?.slice(1).find((v) => v !== undefined)
  const dropAttrs = (attrs: string, names: string[]) =>
    attrs.replace(new RegExp(`\\s(?:${names.join('|')})(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s"'>]+))?`, 'gi'), '')

  let html = utf8.decode(files[entry])
  // <script src> → inline script; integrity and crossorigin no longer apply
  html = html.replace(/<script\b([^>]*)>\s*<\/script\s*>/gi, (tag, attrs: string) => {
    const src = attr(tag, 'src')
    const path = src && resolve(src, entry)
    if (!path) return tag
    use(path)
    const code = content(path).replace(/<\/script/gi, '<\\/script').replace(/<!--/g, '<\\!--')
    return `<script${dropAttrs(attrs, ['src', 'integrity', 'crossorigin', 'defer', 'async'])}>${code}</script>`
  })
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = attr(tag, 'rel')?.toLowerCase().split(/\s+/) ?? []
    const href = attr(tag, 'href')
    const path = href && resolve(href, entry)
    if (!path) return tag
    // stylesheets become <style>; preloads of inlined files are pointless
    if (rel.includes('stylesheet')) {
      use(path)
      const media = attr(tag, 'media')
      const css = content(path).replace(/<\/style/gi, '<\\/style')
      return `<style${media ? ` media="${media}"` : ''}>${css}</style>`
    }
    if (rel.some((r) => r === 'modulepreload' || r === 'preload' || r === 'prefetch')) {
      if (JS.has(ext(path))) problems.push(`${entry} preloads ${path} (a code-split chunk)`)
      return ''
    }
    return tag
  })
  html = inlineRefs(html, entry)

  if (problems.some((p) => p.endsWith('(a code-split chunk)'))) problems.push(SPLIT_HINT)
  if (problems.length) throw new PackError([...new Set(problems)])
  const unused = paths.filter((p) => !used.has(p) && !IGNORED.test(p))
  return { html: new TextEncoder().encode(html), inlined, unused }
}
