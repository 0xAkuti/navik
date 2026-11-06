#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Command, Option } from 'commander'
import * as navik from '@navik/sdk'
import { type Address, concat as concatBytes, formatGwei, getAddress, type Hex, isAddress, parseGwei } from 'viem'
import { getGasPrice } from 'viem/actions'

import { ciRunUrl, type DeployResult, reportReproductionToGitHub, reportToGitHub } from './ci.ts'
import { type GlobalOptions, loadArkiv, loadArkivWriter, loadCtx, swarmApi, swarmBatch } from './config.ts'
import { buildSite, describePack, findConfig, readSite, recordedBuild, shouldCompress } from './site.ts'
import { describeSmoke, smoke } from './smoke.ts'
import { extractTar, gitArchive, gitCheckout, type GitSource, gitSource, runBuild, tarCommit } from './source.ts'

/** Set by bundle.ts; running from source reports "dev". */
declare const __NAVIK_CLI_VERSION__: string | undefined

const program = new Command()
  .name('navik')
  .version(typeof __NAVIK_CLI_VERSION__ === 'undefined' ? 'dev' : __NAVIK_CLI_VERSION__)
  .description('Deploy fully onchain websites to <project>.navik.eth (ENSv2 + ERC-8244)')
  .option('--rpc <url>', 'JSON-RPC endpoint (env RPC_URL, default http://127.0.0.1:8545)')
  .option('--deployment <file>', 'Navik deployment JSON (env NAVIK_DEPLOYMENT, default contracts/deployments/<chainId>.json)')

const ctx = () => loadCtx(program.opts<GlobalOptions>())
const permission = () =>
  new Option('--permission <kind>', 'publish: ship releases · promote: change production')
    .choices(['publish', 'promote'])
    .default('publish')

program
  .command('info')
  .description('show the Navik contracts in use')
  .action(async () => {
    const c = await ctx()
    const d = c.deployment
    const root = await navik.rootStatus(c)
    console.log(`root        ${d.root}  owner ${root.owner}`)
    console.log(`            ${root.attached ? 'attached to these contracts' : 'NOT attached to these contracts'}`)
    console.log(
      root.frozen
        ? '            frozen: nobody can repoint the namespace'
        : '            not frozen: the owner can still repoint the namespace (testing phase)',
    )
    console.log(`chain       ${d.chainId}`)
    console.log(`registrar   ${d.registrar}`)
    console.log(`registry    ${d.registry}`)
    console.log(`factory     ${d.factory}`)
    console.log(`resolver    ${d.resolver}`)
    if (c.account) console.log(`account     ${c.account}`)
  })

program
  .command('claim')
  .description('claim <project>.navik.eth; you become the only role holder of its resolver')
  .argument('<project>')
  .option('--owner <address>', 'owner of the new name (default: your account)')
  .action(async (project: string, opts: { owner?: string }) => {
    const c = await ctx()
    const { name, resolver, releaseRegistry, hash } = await navik.claim(
      c,
      project,
      opts.owner ? addr(opts.owner) : undefined,
    )
    console.log(`claimed ${name}`)
    console.log(`  resolver ${resolver} (production)`)
    console.log(`  releases ${releaseRegistry} (registry for <N>.${name} and preview.${name})`)
    console.log(`  tx       ${hash}`)
  })

program
  .command('build')
  .description("run navik.json's build and pack its output into the one document a release stores (no chain needed)")
  .argument('[dir]', 'where to look for navik.json (default: here and up)')
  .option('--skip-build', 'pack the existing output without running "build"')
  .option('--smoke', 'load the result in headless Chromium, sandboxed like the viewer, and fail if it breaks')
  .option('--out <file>', 'write the document to a file (e.g. to compare in the viewer)')
  .action(async (dir: string | undefined, opts: { skipBuild?: boolean; smoke?: boolean; out?: string }) => {
    const config = findConfig(dir)
    if (!config) throw new Error(`no navik.json in ${resolve(dir ?? '.')} or its parents`)
    if (!opts.skipBuild) buildSite(config)
    const site = readSite(resolve(config.dir, config.output))
    if (site.pack) for (const line of describePack(site.pack)) console.log(line)
    const compress = await shouldCompress(site, config.compress)
    const stored = await navik.storedLayout(site.bytes, { compress, assets: site.pack?.assets })
    const chunks = stored.regions.reduce((n, length) => n + Math.ceil(length / CHUNK_SIZE), 0)
    console.log(`size         ${site.bytes.length} bytes${compress ? `, ${stored.bytes.length} compressed` : ''} → ${chunks} chunk(s)`)
    if (stored.segments) console.log(`segments     ${stored.segments} asset(s) in chunks of their own, reused while unchanged`)
    if (opts.out) {
      writeFileSync(opts.out, site.bytes)
      console.log(`wrote        ${opts.out}`)
    }
    if (opts.smoke) await smokeOrFail(stored.bytes)
  })

program
  .command('config')
  .description('print the navik.json in use (found here or in a parent directory), or one of its fields')
  .argument('[field]', 'e.g. project')
  .action((field?: string) => {
    const config = findConfig()
    if (!config) throw new Error(`no navik.json in ${process.cwd()} or its parents`)
    const { dir: _, file, ...fields } = config
    if (!field) return console.log(`${file}\n${JSON.stringify(fields, null, 2)}`)
    if (!(field in fields)) throw new Error(`${file} has no "${field}"`)
    console.log(fields[field as keyof typeof fields])
  })

program
  .command('deploy')
  .description('publish a site as a new permanent release; with no <path>, build and ship what navik.json describes')
  .argument('[project]', 'default: "project" in navik.json')
  .argument('[path]', 'an HTML file, or a build directory to pack into one document (default: navik.json)')
  .option('--promote', 'also make it production')
  .option('--compress', 'store gzip-wrapped with a small loader (cheaper; the site then needs JavaScript)')
  .option('--no-compress', 'store the document as is (default for a single file)')
  .option('--skip-build', 'with navik.json: ship the existing output without running "build"')
  .option('--smoke', 'load the site in headless Chromium first and abort if it breaks')
  .option('--force', 'publish even if the bytes equal the latest release')
  .option('--max-gas-price <gwei>', 'abort if gas is more expensive than this')
  .option('--dry-run', 'print the plan only')
  .option('--json', 'print the result as JSON on stdout (the log goes to stderr)')
  .option('--provenance', 'with navik.json: record on Arkiv which commit and build command produced the release')
  .option('--build <command>', 'with <path>: record provenance on Arkiv: the command (run at the repo root) that built <path>')
  .option('--repo <url>', 'with provenance: public URL of the source repo (default: the origin remote)')
  .option('--swarm', 'with provenance: also put the source (git archive of the commit) on Swarm')
  .option('--notes <text>', 'with provenance: release notes')
  .action(async (projectArg: string | undefined, path: string | undefined, opts: DeployOptions) => {
    if (opts.json) console.log = console.error
    const config = path ? undefined : findConfig()
    if (!path && !config) throw new Error('nothing to deploy: pass <project> <path>, or run where a navik.json is')
    if (config && opts.build) throw new Error('--build is for deploying a <path>; with navik.json, use --provenance')
    if (path && opts.provenance) throw new Error('--provenance reads navik.json; for a <path>, use --build <command>')
    const project = projectArg ?? config!.project
    const c = await ctx()

    if (config && !opts.skipBuild) buildSite(config)
    const target = config ? resolve(config.dir, config.output) : path!
    // fail before spending gas: a dirty tree or an oversized field cannot become provenance
    const source = config && opts.provenance ? gitSource(target, opts.repo) : opts.build ? gitSource(target, opts.repo) : undefined
    const build = source && (config ? recordedBuild(config, source.root) : opts.build!)
    const site = readSite(target)
    if (site.pack) for (const line of describePack(site.pack)) console.log(line)
    const compress = await shouldCompress(site, opts.compress ?? config?.compress)
    const plan = await navik.planPublish(c, project, site.bytes, { compress, assets: site.pack?.assets })
    const latest = opts.force ? undefined : await navik.latestRelease(c, project)
    const unchanged = latest?.contentHash === plan.contentHash
    const reused = plan.chunks.filter((ch) => ch.stored).length
    const txs = plan.singleTx ? 1 : plan.uploads.length + 1
    if (unchanged) console.log(`release      ${latest.name} (unchanged: same bytes as the latest release, nothing to publish)`)
    else console.log(`release      ${plan.name}`)
    if (plan.compressed) {
      const { originalSize, originalChunks, segments } = plan.compressed
      console.log(`compressed   ${originalSize} → ${plan.size} bytes (${originalChunks} → ${plan.chunks.length} chunks)`)
      if (segments) console.log(`segments     ${segments} asset(s) in chunks of their own, reused while unchanged`)
    }
    console.log(`size         ${plan.size} / ${plan.maxSize} bytes`)
    console.log(`chunks       ${plan.chunks.length} (${reused} already stored, ${plan.chunks.length - reused} new)`)
    console.log(`content hash ${plan.contentHash}`)
    if (!unchanged) {
      console.log(`address      ${plan.predicted} (known before upload)`)
      console.log(`transactions ${txs}${plan.singleTx ? ' (store + publish together)' : ''}`)
    }
    if (opts.smoke) await smokeOrFail(concatBytes(plan.chunks.map((ch) => ch.data)))

    const result: DeployResult = {
      project: navik.projectName(c, project),
      release: unchanged ? latest.name : plan.name,
      version: String(unchanged ? latest.version : plan.version),
      address: unchanged ? latest.deployment : plan.predicted,
      contentHash: plan.contentHash,
      size: plan.size,
      chunks: plan.chunks.length,
      published: false,
      unchanged,
      promoted: false,
      preview: navik.previewName(c, project),
      transactions: [],
    }
    if (!opts.dryRun) {
      if (opts.maxGasPrice && !unchanged) {
        const price = await getGasPrice(c.publicClient)
        const max = parseGwei(opts.maxGasPrice)
        if (price > max) throw new Error(`gas costs ${formatGwei(price)} gwei, above --max-gas-price ${opts.maxGasPrice}; nothing was sent`)
      }
      if (!unchanged) {
        await navik.publish(c, plan, (step) => {
          const what = step.kind === 'upload' ? `uploaded ${step.chunks} chunk(s)` : 'published'
          console.log(`${what.padEnd(12)} tx ${step.hash} (gas ${step.gasUsed})`)
          result.transactions.push(step.hash)
        })
        result.published = true
      }
      if (opts.promote) {
        const live = await navik.resolveContentContract(c, result.project)
        if (live && getAddress(live) === getAddress(result.address)) {
          console.log(`production   ${result.project} already serves ${result.release}`)
        } else {
          const tx = await navik.promote(c, project, result.address as Address)
          console.log(`promoted     ${result.project} → ${result.release} (tx ${tx})`)
          result.transactions.push(tx)
          result.promoted = true
        }
        result.production = result.project
      }
      if (source && build && !unchanged) {
        result.provenance = await recordSource(c, { name: plan.name, project: result.project, site: plan.predicted }, plan, source, build, opts)
      }
    }
    reportToGitHub(result)
    if (opts.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  })

program
  .command('record')
  .description('record on Arkiv which source and build command produced an existing release')
  .argument('<name>', 'the release, e.g. 3.portfolio or navik.eth')
  .argument('<path>', 'the built file or build directory, inside a clean git checkout of the source')
  .requiredOption('--build <command>', 'the command (run at the repo root) that built <path>')
  .option('--repo <url>', 'public URL of the source repo (default: the origin remote)')
  .option('--swarm', 'also put the source (git archive of the commit) on Swarm')
  .option('--notes <text>', 'release notes')
  .action(async (name: string, file: string, opts: DeployOptions & { build: string }) => {
    const c = await ctx()
    const source = gitSource(file, opts.repo)
    const v = await navik.verify(c, name)
    if (!v.hashMatches) throw new Error(`${v.name} failed verification; run \`navik verify\``)
    if (!navik.compareBuild(v, readSite(file).bytes).matches) throw new Error(`${file} is not what ${v.name} serves`)
    const release = v.releaseName ?? v.name
    const project = v.project ? navik.projectName(c, v.project) : v.name
    const version = v.version ?? 0n
    await recordSource(c, { name: release, project, site: v.deployment }, { version, contentHash: v.contentHash }, source, opts.build, opts)
  })

program
  .command('provenance')
  .description('show the source a site was built from and who reproduced it (from Arkiv)')
  .argument('<name>', 'any name with a contentcontract record')
  .action(async (name: string) => {
    const c = await ctx()
    const v = await navik.verify(c, name)
    const r = await siteRecords(c, v)
    console.log(`${v.name} → ${v.deployment}  content ${v.contentHash}`)
    if (r.trusted) {
      const p = r.trusted
      console.log(`  source     ${p.repo} @ ${p.commit}`)
      console.log(`  build      ${p.build}  →  ${p.output}`)
      if (p.sourceSwarm) console.log(`  on Swarm   ${navik.swarmLinks(p.sourceSwarm).bzz}  (keccak256 ${p.sourceHash})`)
      if (p.notes) console.log(`  notes      ${p.notes}`)
      console.log(`  written by ${p.creator}, the publisher  · entity ${p.key}  · expires ${r.expires(p.expiresAt)}`)
    } else {
      console.log(r.publisher ? `  no provenance from the publisher ${r.publisher}` : '  no publisher known (not a Navik release): provenance below is unverified')
    }
    for (const p of r.provenance.filter((p) => p !== r.trusted)) {
      console.log(`  ✗ ignored  provenance by ${p.creator} (not the publisher): ${p.repo} @ ${p.commit.slice(0, 12)}`)
    }
    const ok = r.attestations.filter((a) => a.result === 'match')
    console.log(`  reproduced by ${ok.length} builder(s)${ok.length < r.attestations.length ? `, ${r.attestations.length - ok.length} could not` : ''}`)
    for (const a of r.attestations) {
      console.log(`    ${a.result === 'match' ? '✓' : '✗'} ${a.creator}  ${a.commit ? `@ ${a.commit.slice(0, 12)} ` : ''}via ${a.tool}  · entity ${a.key}`)
      if (a.log) console.log(`      log ${a.log}`)
    }
  })

program
  .command('reproduce')
  .description('rebuild a site from the source its publisher recorded, compare byte for byte, optionally attest on Arkiv')
  .argument('<name>', 'any name with a contentcontract record')
  .option('--git', 'fetch the source from its git repo even if it is on Swarm')
  .option('--attest', 'publish the result (match or mismatch) as an attestation on Arkiv')
  .option('--yes', "run the recorded build command (it is the publisher's code: read it first, or use a sandbox)")
  .option('--tool <name>', 'with --attest: what made the attestation (default navik-ci in GitHub Actions, else navik-cli)')
  .option('--log <url>', 'with --attest: public https log of this rebuild (default: the GitHub Actions run)')
  .action(async (name: string, opts: { git?: boolean; attest?: boolean; yes?: boolean; tool?: string; log?: string }) => {
    const c = await ctx()
    const v = await navik.verify(c, name)
    if (!v.hashMatches) throw new Error(`${v.name} failed verification; run \`navik verify\``)
    const { trusted } = await siteRecords(c, v)
    if (!trusted) throw new Error(`${v.name} has no provenance from its publisher; use scripts/reproduce.sh with a repo and command of your choice`)
    console.log(`source  ${trusted.repo} @ ${trusted.commit}`)
    console.log(`build   ${trusted.build}  →  ${trusted.output}`)
    if (!opts.yes) {
      console.log('re-run with --yes to run this build command on your machine')
      process.exitCode = 2
      return
    }
    const work = mkdtempSync(join(tmpdir(), 'navik-reproduce-'))
    try {
      const dir = join(work, 'src')
      mkdirSync(dir)
      if (trusted.sourceSwarm && !opts.git) {
        const api = swarmApi()
        console.log(`fetch   ${trusted.sourceSwarm} from ${api}`)
        const tar = await navik.swarmDownload(api, trusted.sourceSwarm, trusted.sourceHash)
        const commit = tarCommit(tar)
        if (commit !== trusted.commit) throw new Error(`the Swarm source is commit ${commit}, provenance says ${trusted.commit}`)
        console.log(`        ✓ keccak256 matches the provenance, commit ${commit}`)
        extractTar(tar, dir)
      } else {
        rmSync(dir, { recursive: true })
        gitCheckout(trusted.repo, trusted.commit, dir)
      }
      runBuild(dir, trusted.build)
      const built = readSite(join(dir, trusted.output)).bytes
      const cmp = navik.compareBuild(v, built)
      console.log(cmp.matches ? `✓ byte-identical to ${v.name}` : `✗ the rebuild (keccak256 ${cmp.hash}) differs from ${v.name}`)
      if (!cmp.matches) process.exitCode = 1
      let attestation: string | undefined
      if (opts.attest) {
        const { entityKey, txHash } = await navik.attest(loadArkivWriter(), {
          chainId: c.publicClient.chain.id,
          site: v.deployment,
          contentHash: v.contentHash,
          name: v.name,
          result: cmp.matches ? 'match' : 'mismatch',
          builtHash: cmp.hash,
          provenance: trusted.key,
          repo: trusted.repo,
          commit: trusted.commit,
          build: trusted.build,
          tool: opts.tool ?? (ciRunUrl() ? 'navik-ci' : 'navik-cli'),
          log: opts.log ?? ciRunUrl(),
        })
        attestation = entityKey
        console.log(`attested on Arkiv: entity ${entityKey} (tx ${txHash})`)
      }
      reportReproductionToGitHub({ name: v.name, commit: trusted.commit, reproduced: cmp.matches, builtHash: cmp.hash, attestation })
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })

program
  .command('keep-alive')
  .description("extend a site's provenance and attestations on Arkiv to the maximum lifetime (anyone may)")
  .argument('<name>')
  .action(async (name: string) => {
    const c = await ctx()
    const v = await navik.verify(c, name)
    const r = await siteRecords(c, v)
    const keys = [...(r.trusted ? [r.trusted.key] : []), ...r.attestations.map((a) => a.key)]
    if (keys.length === 0) return console.log(`${v.name}: nothing on Arkiv to extend`)
    const res = await navik.keepAlive(loadArkivWriter(), keys)
    console.log(`extended ${keys.length} entit${keys.length === 1 ? 'y' : 'ies'} by ${navik.ARKIV_LIFETIME_DAYS} days (tx ${res?.txHash})`)
  })

program
  .command('promote')
  .alias('rollback')
  .description('point production <project>.navik.eth at an existing release')
  .argument('<project>')
  .argument('<version>', 'v1, v2, …')
  .action(async (project: string, version: string) => {
    const c = await ctx()
    const v = navik.parseVersion(version)
    const deployment = await navik.deploymentOf(c, project, v)
    const tx = await navik.promote(c, project, deployment)
    console.log(`${navik.projectName(c, project)} → ${navik.releaseName(c, project, v)} (${deployment})`)
    console.log(`  tx ${tx}`)
  })

program
  .command('demote')
  .description('clear production; releases keep their names')
  .argument('<project>')
  .action(async (project: string) => {
    const c = await ctx()
    const tx = await navik.demote(c, project)
    console.log(`${navik.projectName(c, project)} → (none)`)
    console.log(`  tx ${tx}`)
  })

program
  .command('grant')
  .description('let another key publish releases or change production for this project only')
  .argument('<project>')
  .argument('<account>')
  .addOption(permission())
  .action(async (project: string, account: string, opts: { permission: navik.Permission }) => {
    const c = await ctx()
    const tx = await navik.grant(c, project, addr(account), opts.permission)
    console.log(`granted ${opts.permission} on ${navik.projectName(c, project)} to ${addr(account)}`)
    console.log(`  tx ${tx}`)
  })

program
  .command('revoke')
  .description('remove a key permission granted with `grant`')
  .argument('<project>')
  .argument('<account>')
  .addOption(permission())
  .action(async (project: string, account: string, opts: { permission: navik.Permission }) => {
    const c = await ctx()
    const tx = await navik.revoke(c, project, addr(account), opts.permission)
    console.log(`revoked ${opts.permission} on ${navik.projectName(c, project)} from ${addr(account)}`)
    console.log(`  tx ${tx}`)
  })

const STEP_TEXT: Record<navik.DomainStep, string> = {
  record: 'project resolver: link the name to production (project owner)',
  resolver: "name's resolver → the project's resolver (domain owner)",
  subregistry: "name's subregistry → the project's release registry (domain owner)",
}

const UNLINK_TEXT: Record<navik.DomainStep, string> = {
  record: 'project resolver: drop the link to production (project owner)',
  resolver: "name's resolver → its previous resolver (domain owner)",
  subregistry: "name's subregistry → its previous subregistry (domain owner)",
}

function printDomainChange(change: navik.DomainChange, text = STEP_TEXT) {
  for (const s of change.sent) console.log(`  ✓ ${text[s.step]}\n    tx ${s.hash}`)
  for (const s of change.waiting) console.log(`  … waiting: ${text[s]}`)
  // this key could do none of what is left
  if (!change.sent.length && change.waiting.length) process.exitCode = 1
}

program
  .command('link')
  .description('serve a project from your own name: <domain> → production, <N>.<domain> → releases')
  .argument('<project>')
  .argument('<domain>', 'a .eth name (or subname) you own, e.g. alice.eth')
  .action(async (project: string, domain: string) => {
    const c = await ctx()
    const before = await navik.domainStatus(c, project, domain)
    if (before.linked) return console.log(`${before.name} already serves ${navik.projectName(c, project)}`)
    if (!before.previous && !before.done.resolver)
      console.log(`${before.name} now uses resolver ${before.resolver}, subregistry ${before.subregistry} (recorded for unlink)`)
    const change = await navik.linkDomain(c, project, domain)
    printDomainChange(change)
    if (change.waiting.length) {
      console.log(`partly linked: the other owner runs \`navik link ${project} ${before.name}\` to finish`)
      return
    }
    console.log(`linked       ${before.name} → ${navik.projectName(c, project)}`)
    console.log(`             <N>.${before.name} and preview.${before.name} serve its releases`)
  })

program
  .command('unlink')
  .description("stop a name from serving a project; restores the name's previous resolver and subregistry")
  .argument('<project>')
  .argument('<domain>')
  .action(async (project: string, domain: string) => {
    const c = await ctx()
    const change = await navik.unlinkDomain(c, project, domain)
    printDomainChange(change, UNLINK_TEXT)
    if (!change.sent.length && !change.waiting.length) return console.log(`${domain} is not linked to ${project}`)
    console.log(change.waiting.length ? 'partly unlinked: the other owner runs the same command' : `unlinked     ${domain}`)
  })

program
  .command('domains')
  .description('list the names linked to a project')
  .argument('<project>')
  .action(async (project: string) => {
    const c = await ctx()
    const domains = await navik.listDomains(c, project)
    if (!domains.length) console.log(`no domains linked to ${navik.projectName(c, project)}`)
    for (const d of domains) {
      const missing = navik.DOMAIN_STEPS.filter((s) => !d.done[s])
      console.log(`${d.linked ? '●' : '◐'} ${d.name}  owner ${d.owner}${missing.length ? `  (missing: ${missing.join(', ')})` : ''}`)
    }
  })

program
  .command('ls')
  .description('list releases and which one is live')
  .argument('<project>')
  .action(async (project: string) => {
    const c = await ctx()
    const owner = await navik.projectOwner(c, project)
    const { releases, live, preview } = await navik.listReleases(c, project)
    const is = (a: Address | undefined, b: Address) => !!a && getAddress(a) === getAddress(b)
    console.log(`${navik.projectName(c, project)}  owner ${owner}`)
    if (releases.length === 0) console.log('  no releases yet')
    for (const r of releases) {
      const mark = is(live, r.deployment) ? '● live' : '      '
      const chunks = `${r.chunks} chunk${r.chunks === 1 ? '' : 's'}`
      const tag = is(preview, r.deployment) ? `  ← ${navik.previewName(c, project)}` : ''
      console.log(
        `  ${mark}  ${r.name.padEnd(36)} ${r.deployment}  ${r.size} B  ${chunks}  ${r.contentHash.slice(0, 10)}…${tag}`,
      )
    }
    if (live && !releases.some((r) => getAddress(r.deployment) === getAddress(live))) {
      console.log(`  ● live  ${live} (not a release of this project)`)
    }
  })

program
  .command('resolve')
  .description('resolve the contentcontract of any ENS name through ENSv2')
  .argument('<name>')
  .action(async (name: string) => {
    const c = await ctx()
    const fqdn = navik.fullName(c, name)
    const d = await navik.resolveContentContract(c, fqdn)
    console.log(d ? `${fqdn} → ${d}` : `${fqdn} → (none)`)
  })

program
  .command('verify')
  .description('resolve a name, check it is a genuine release and that html() matches its content hash')
  .argument('<name>', 'portfolio, 2.portfolio, preview.portfolio, portfolio.navik.eth or any ENS name')
  .option('--out <file>', 'write the verified HTML to a file (the original document if gzip-wrapped)')
  .option('--raw', 'with --out: write the exact stored bytes, even if gzip-wrapped')
  .option('--against <path>', 'check a local build (an HTML file or build directory) is byte-identical to the release')
  .option('--attest', 'with --against: publish the result as an attestation on Arkiv')
  .action(async (name: string, opts: { out?: string; raw?: boolean; against?: string; attest?: boolean }) => {
    const c = await ctx()
    const v = await navik.verify(c, name)
    const ok = v.isNavikDeployment && v.hashMatches && v.belongsToProject !== false
    console.log(`${v.name} → ${v.deployment}`)
    console.log(`  ${tick(v.isNavikDeployment)} created by the Navik factory`)
    if (v.belongsToProject !== undefined) console.log(`  ${tick(v.belongsToProject)} belongs to ${v.project ?? 'this project'}`)
    if (v.releaseName) console.log(`  ✓ release ${v.releaseName}`)
    console.log(`  ${tick(v.hashMatches)} html() matches content hash ${v.contentHash}`)
    if (v.original) console.log(`  ✓ gzip-wrapped: original ${v.original.html.length} bytes, keccak256 ${v.original.hash}`)
    if (opts.against) {
      const local = navik.compareBuild(v, readSite(opts.against).bytes)
      console.log(
        local.matches
          ? `  ✓ ${opts.against} is byte-identical to the ${local.matched === 'original' ? 'original document' : 'release'}`
          : `  ✗ ${opts.against} (keccak256 ${local.hash}) differs from the release`,
      )
      if (!local.matches) process.exitCode = 1
      if (opts.attest) {
        const { trusted } = await siteRecords(c, v)
        const { entityKey, txHash } = await navik.attest(loadArkivWriter(), {
          chainId: c.publicClient.chain.id,
          site: v.deployment,
          contentHash: v.contentHash,
          name: v.name,
          result: local.matches ? 'match' : 'mismatch',
          builtHash: local.hash,
          provenance: trusted?.key,
          tool: 'navik-cli',
        })
        console.log(`  attested on Arkiv: entity ${entityKey} (tx ${txHash})`)
      }
    }
    if (opts.out) {
      const bytes = v.original && !opts.raw ? v.original.html : v.html
      writeFileSync(opts.out, bytes)
      console.log(`  wrote ${bytes.length} bytes to ${opts.out}`)
    }
    if (!ok) process.exitCode = 1
  })

program
  .command('open')
  .description('fetch and verify a site from Ethereum, write it locally (no servers involved)')
  .argument('<name>')
  .action(async (name: string) => {
    const c = await ctx()
    const v = await navik.verify(c, name)
    if (!(v.isNavikDeployment && v.hashMatches)) throw new Error(`${v.name} failed verification; run \`navik verify\``)
    const dir = join(tmpdir(), 'navik')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `${v.name}.html`)
    writeFileSync(file, v.original?.html ?? v.html)
    console.log(pathToFileURL(file).href)
  })

type DeployOptions = {
  promote?: boolean
  compress?: boolean
  skipBuild?: boolean
  smoke?: boolean
  force?: boolean
  maxGasPrice?: string
  dryRun?: boolean
  json?: boolean
  provenance?: boolean
  build?: string
  repo?: string
  swarm?: boolean
  notes?: string
}

/** Uploads the source to Swarm (optional), then writes the release's provenance to Arkiv. */
async function recordSource(
  c: navik.Ctx,
  release: { name: string; project: string; site: Address },
  plan: { version: bigint; contentHash: Hex },
  source: GitSource,
  build: string,
  opts: DeployOptions,
) {
  let swarm: { reference: string; hash: Hex } | undefined
  if (opts.swarm) {
    const tar = gitArchive(source.root, source.commit)
    swarm = await navik.swarmUpload(swarmApi(), swarmBatch(), tar, { name: `${source.commit}.tar`, contentType: 'application/x-tar' })
    console.log(`source       ${navik.swarmLinks(swarm.reference).bzz} (${tar.length} bytes, git archive ${source.commit.slice(0, 12)})`)
  }
  const { entityKey, txHash } = await navik.recordProvenance(loadArkivWriter(), {
    chainId: c.publicClient.chain.id,
    site: release.site,
    contentHash: plan.contentHash,
    name: release.name,
    project: release.project,
    version: plan.version,
    repo: source.repo,
    commit: source.commit,
    build,
    output: source.output,
    sourceSwarm: swarm?.reference,
    sourceHash: swarm?.hash,
    notes: opts.notes,
  })
  console.log(`provenance   ${source.repo} @ ${source.commit.slice(0, 12)} → Arkiv entity ${entityKey} (tx ${txHash})`)
  return entityKey
}

async function smokeOrFail(html: Uint8Array) {
  const report = await smoke(html)
  for (const line of describeSmoke(report)) console.log(line)
  if (!report.ok) throw new Error('the smoke test failed; nothing was published')
}

/** A site's records on Arkiv, and which provenance is trusted (written by the release's publisher). */
async function siteRecords(c: navik.Ctx, v: navik.Verification) {
  const arkiv = loadArkiv()
  const chainId = c.publicClient.chain.id
  const [provenance, attestations, publisher, block] = await Promise.all([
    navik.provenanceOf(arkiv, chainId, v.deployment),
    navik.attestationsOf(arkiv, chainId, v.contentHash),
    v.isNavikDeployment ? navik.publisherOf(c, v.deployment) : undefined,
    navik.arkivBlock(arkiv),
  ])
  const trusted = navik.trustedProvenance(provenance, publisher)
  const expires = (at: bigint) => navik.expiryDate(at, block).toISOString().slice(0, 10)
  return { provenance, attestations, publisher, trusted, expires }
}

function addr(value: string): Address {
  if (!isAddress(value)) throw new Error(`not an address: ${value}`)
  return getAddress(value)
}

/** NavikChunks.CHUNK_SIZE, for estimates made without a chain */
const CHUNK_SIZE = 24_575

function tick(ok: boolean) {
  return ok ? '✓' : '✗'
}

program.parseAsync().catch((err: unknown) => {
  console.error(`error: ${navik.describeError(err)}`)
  process.exit(1)
})
