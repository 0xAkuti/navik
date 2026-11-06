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

/** The public log of this GitHub Actions run, if running in one. */
export function ciRunUrl(): string | undefined {
  const { GITHUB_SERVER_URL: server, GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: run } = process.env
  return server && repo && run ? `${server}/${repo}/actions/runs/${run}` : undefined
}

export type ReproductionResult = { name: string; commit: string; reproduced: boolean; builtHash: string; attestation?: string }

/** `navik reproduce` in GitHub Actions: step outputs `reproduced`, `built-hash`, `attestation`, and a summary. */
export function reportReproductionToGitHub(r: ReproductionResult) {
  const out = process.env.GITHUB_OUTPUT
  if (out) {
    const lines = [`reproduced=${r.reproduced}`, `built-hash=${r.builtHash}`, ...(r.attestation ? [`attestation=${r.attestation}`] : [])]
    appendFileSync(out, `${lines.join('\n')}\n`)
  }
  const summary = process.env.GITHUB_STEP_SUMMARY
  if (summary) {
    const verdict = r.reproduced ? '✓ byte-identical' : '✗ differs'
    const rows = [
      ['site', `\`${r.name}\``],
      ['source', `commit \`${r.commit}\``],
      ['rebuild', `${verdict} (keccak256 \`${r.builtHash}\`)`],
      ['attestation', r.attestation ? `Arkiv entity \`${r.attestation}\`` : 'not published'],
    ]
    appendFileSync(summary, `### Navik: reproduce ${r.name}\n\n| | |\n|---|---|\n${rows.map(([k, v]) => `| ${k} | ${v} |`).join('\n')}\n\n`)
  }
}
