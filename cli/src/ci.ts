import { appendFileSync } from 'node:fs'

/** What `navik deploy --json` prints, and what GitHub Actions gets as step outputs. */
export type DeployResult = {
  project: string
  release: string
  version: string
  address: string
  contentHash: string
  size: number
  chunks: number
  /** false for --dry-run, or when the bytes equal the latest release (nothing to publish) */
  published: boolean
  unchanged: boolean
  promoted: boolean
  production?: string
  preview: string
  provenance?: string
  transactions: string[]
}

/** Writes step outputs and a job summary when running in GitHub Actions; no-op elsewhere. */
export function reportToGitHub(r: DeployResult) {
  const out = process.env.GITHUB_OUTPUT
  if (out) {
    const lines = Object.entries(r)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}=${Array.isArray(v) ? v.join(',') : v}`)
    appendFileSync(out, `${lines.join('\n')}\n`)
  }
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) {
    const status = r.unchanged ? 'unchanged, nothing published' : r.published ? 'published' : 'dry run'
    const rows = [
      ['release', `\`${r.release}\` (${status})`],
      ['address', `\`${r.address}\``],
      ['size', `${r.size.toLocaleString('en')} bytes in ${r.chunks} chunk(s)`],
      ['content hash', `\`${r.contentHash}\``],
      ['preview', `\`${r.preview}\``],
      ['production', r.promoted ? `\`${r.production}\` → this release` : 'not changed'],
      ...(r.provenance ? [['provenance', `Arkiv entity \`${r.provenance}\``]] : []),
    ]
    appendFileSync(summary, `### Navik: ${r.project}\n\n| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}\n\n`)
  }
}
