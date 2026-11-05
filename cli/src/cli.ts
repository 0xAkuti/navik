#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Command, Option } from 'commander'
import * as navik from '@navik/sdk'
import { type Address, getAddress, isAddress } from 'viem'

import { type GlobalOptions, loadCtx } from './config.ts'

const program = new Command()
  .name('navik')
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
  .command('deploy')
  .description('publish a prebuilt HTML file as a new permanent release')
  .argument('<project>')
  .argument('<file>', 'single-file HTML document')
  .option('--promote', 'also make it production')
  .option('--compress', 'store gzip-wrapped with a small loader (cheaper; the site then needs JavaScript)')
  .option('--dry-run', 'print the plan only')
  .action(async (project: string, file: string, opts: { promote?: boolean; compress?: boolean; dryRun?: boolean }) => {
    const c = await ctx()
    const plan = await navik.planPublish(c, project, new Uint8Array(readFileSync(file)), { compress: opts.compress })
    const reused = plan.chunks.filter((ch) => ch.stored).length
    const txs = plan.singleTx ? 1 : plan.uploads.length + 1
    console.log(`release      ${plan.name}`)
    if (plan.compressed) {
      const { originalSize, originalChunks } = plan.compressed
      console.log(`compressed   ${originalSize} → ${plan.size} bytes (${originalChunks} → ${plan.chunks.length} chunks)`)
    }
    console.log(`size         ${plan.size} / ${plan.maxSize} bytes`)
    console.log(`chunks       ${plan.chunks.length} (${reused} already stored, ${plan.chunks.length - reused} new)`)
    console.log(`content hash ${plan.contentHash}`)
    console.log(`address      ${plan.predicted} (known before upload)`)
    console.log(`transactions ${txs}${plan.singleTx ? ' (store + publish together)' : ''}`)
    if (opts.dryRun) return

    await navik.publish(c, plan, (step) => {
      const what = step.kind === 'upload' ? `uploaded ${step.chunks} chunk(s)` : 'published'
      console.log(`${what.padEnd(12)} tx ${step.hash} (gas ${step.gasUsed})`)
    })
    if (opts.promote) {
      const tx = await navik.promote(c, project, plan.predicted)
      console.log(`promoted     ${navik.projectName(c, project)} → ${plan.name} (tx ${tx})`)
    }
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
  .option('--against <file>', 'check a local build (e.g. from the source repo) is byte-identical to the release')
  .action(async (name: string, opts: { out?: string; raw?: boolean; against?: string }) => {
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
      const local = navik.compareBuild(v, readFileSync(opts.against))
      console.log(
        local.matches
          ? `  ✓ ${opts.against} is byte-identical to the ${local.matched === 'original' ? 'original document' : 'release'}`
          : `  ✗ ${opts.against} (keccak256 ${local.hash}) differs from the release`,
      )
      if (!local.matches) process.exitCode = 1
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

function addr(value: string): Address {
  if (!isAddress(value)) throw new Error(`not an address: ${value}`)
  return getAddress(value)
}

function tick(ok: boolean) {
  return ok ? '✓' : '✗'
}

program.parseAsync().catch((err: unknown) => {
  console.error(`error: ${navik.describeError(err)}`)
  process.exit(1)
})
