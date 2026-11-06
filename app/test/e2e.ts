// Drives the built single-file app (dist/index.html) in headless Chromium against a local
// mainnet fork with Navik deployed (scripts/dev-fork.sh). A test wallet is injected via
// EIP-6963 and forwards every request to anvil, whose dev accounts are unlocked.
// With ARKIV_PRIVATE_KEY (tGLM on Arkiv's testnet), the wallet also signs on Arkiv with that key,
// and the viewer's attestation and keep-alive are exercised against the real testnet.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { arkivChain } from '@navik/sdk'
import { chromium, type Page } from 'playwright'
import { createWalletClient, encodeFunctionData, type Hex, http, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545'
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // anvil #1
const CI = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' // anvil #2
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045' // primary name vitalik.eth on mainnet, so on the fork
// APP_FILE: e.g. the copy of the app fetched from Ethereum with `navik open navik.eth`
// APP_URL: e.g. the app through a gateway (cli/test/gateway), as navik.eth.limo serves it
const APP = process.env.APP_URL ?? pathToFileURL(process.env.APP_FILE ?? resolve(import.meta.dirname, '../dist/index.html')).href
const SHOTS = process.env.SHOTS ?? '/tmp/navik-app'

const project = `web${Date.now().toString(36)}`
const site = (v: number) => Buffer.from(`<!doctype html><title>${project}</title><h1>hello from v${v}</h1>`)

function injectWallet({ rpc, account, arkiv }: { rpc: string; account: string; arkiv: string }) {
  let id = 0
  let onArkiv = false
  const seen: string[] = ((window as unknown as { walletMethods: string[] }).walletMethods = [])
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      seen.push(method)
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account]
      if (method === 'wallet_switchEthereumChain') {
        onArkiv = (params?.[0] as { chainId: string }).chainId === arkiv
        return null
      }
      // on Arkiv, the test signs in Node with ARKIV_PRIVATE_KEY (see arkivSend)
      if (onArkiv && method === 'eth_chainId') return arkiv
      if (onArkiv && method === 'eth_sendTransaction') return (window as unknown as { arkivSend: (tx: unknown) => Promise<string> }).arkivSend(params?.[0])
      const res = await fetch(rpc, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }),
      })
      const json = await res.json()
      if (json.error) throw Object.assign(new Error(json.error.message), json.error)
      return json.result
    },
    on() {},
    removeListener() {},
  }
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info: { uuid: 'navik-test', name: 'Navik Test Wallet', icon: '', rdns: 'test.navik' }, provider }),
      }),
    )
  window.addEventListener('eip6963:requestProvider', announce)
}

/** Settled screenshots: animations finished, scrolled to the top so the sticky header sits in place. */
async function shot(page: Page, opts: { path: string; fullPage?: boolean }) {
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ ...opts, animations: 'disabled' })
}

async function step(name: string, fn: () => Promise<void>) {
  process.stdout.write(`• ${name} … `)
  await fn()
  console.log('ok')
}

// the only requests the app may send to the wallet: no reads, so the wallet's RPC learns nothing
const WALLET_METHODS = new Set(['eth_requestAccounts', 'eth_accounts', 'eth_chainId', 'eth_sendTransaction', 'wallet_switchEthereumChain'])
// the passthrough anon-rpc worker's code, keccak-pinned in the app
const WORKER_BUNDLE = 'https://raw.githubusercontent.com/privacy-ethereum/anon-rpc/'
// Arkiv (release provenance): read through the passthrough worker too, so the test needs no mixnet
const ARKIV_RPC = 'https://rpc.rabdi.db-chain.testnet.arkiv.network'
function arkivPassthrough(rpc: string) {
  // init scripts also run in the sandboxed frames, which have no storage
  if (window.top === window) localStorage.setItem('navik:reads:7794095', JSON.stringify({ network: 'passthrough', rpc }))
}
const siteFrame = (page: Page) => page.frameLocator('iframe.site-frame')

const production = (page: Page) => page.locator('.prod-live')
const releaseRow = (page: Page, v: number) => page.locator('.release', { hasText: `${v}.${project}.navik.eth` })
const modal = (page: Page) => page.locator('.modal')

async function connect(page: Page) {
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await modal(page).getByRole('button', { name: 'Navik Test Wallet' }).click()
  await page.getByRole('heading', { name: 'Projects' }).waitFor()
}

/** Opens the deploy dialog, picks a build, waits for the plan; `options` runs before picking. */
async function pickBuild(page: Page, v: number, options?: () => Promise<void>) {
  await page.getByRole('button', { name: 'Deploy', exact: true }).click()
  await options?.()
  await modal(page).locator('input[type=file]').setInputFiles({ name: 'index.html', mimeType: 'text/html', buffer: site(v) })
  await modal(page).getByText(`${v}.${project}.navik.eth`).waitFor()
}

async function finishDeploy(page: Page, button: 'Deploy' | 'Deploy and promote') {
  await modal(page).getByRole('button', { name: button, exact: true }).click()
  await modal(page).getByRole('button', { name: 'Done' }).click()
}

async function rpc(method: string, params: unknown[] = []) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const json = await res.json()
  if (json.error) throw new Error(`${method}: ${json.error.message}`)
  return json.result
}

async function waitForReceipt(hash: string) {
  for (let i = 0; i < 50; i++) {
    const receipt = await rpc('eth_getTransactionReceipt', [hash])
    if (receipt) return receipt
    await new Promise((r) => setTimeout(r, 200))
  }
}

/** Sends a transaction from any account on the fork (anvil impersonation). */
async function sendAs(from: string, to: string, data: Hex, what: string) {
  await rpc('anvil_impersonateAccount', [from])
  await rpc('anvil_setBalance', [from, '0xde0b6b3a7640000'])
  const hash = await rpc('eth_sendTransaction', [{ from, to, data }])
  await rpc('anvil_stopImpersonatingAccount', [from])
  assert.equal((await waitForReceipt(hash))?.status, '0x1', what)
}

/** Registers `<label>.eth` for `owner` on the fork, as ENSv2's ETHRegistrar does after a purchase. */
async function registerEth(label: string, owner: string) {
  const registrar = '0xD6D8369e55c94Ae8AFA714E6cF7AB5bE54D5CC81'
  const roles = (1n << 20n) | ((1n << 20n) << 128n) | (1n << 24n) | ((1n << 24n) << 128n) | ((1n << 28n) << 128n)
  const data = encodeFunctionData({
    abi: parseAbi(['function register(string,address,address,address,uint256,uint64)']),
    args: [label, owner as Hex, '0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dEaD', roles, BigInt(Math.floor(Date.now() / 1000) + 365 * 86400)],
  })
  await sendAs(registrar, '0xf60aba43E1f7F3DAB1186Ff03B561401C9Df85E2', data, `registering ${label}.eth`)
}

const browser = await chromium.launch()
const page = await browser.newPage()
const external: string[] = []
page.on('request', (r) => {
  const url = r.url()
  if (!/^(file:|data:|blob:|about:)/.test(url) && ![APP, RPC, WORKER_BUNDLE, ARKIV_RPC].some((u) => url.startsWith(u))) external.push(url)
})
page.on('pageerror', (e) => console.error('page error:', e.message))
await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
await page.addInitScript(injectWallet, { rpc: RPC, account: ALICE, arkiv: `0x${arkivChain().id.toString(16)}` })
const ARKIV_KEY = process.env.ARKIV_PRIVATE_KEY as Hex | undefined
if (ARKIV_KEY) {
  const arkivWallet = createWalletClient({ account: privateKeyToAccount(ARKIV_KEY), chain: arkivChain(), transport: http() })
  await page.exposeFunction('arkivSend', (tx: { to: Hex; data: Hex }) => arkivWallet.sendTransaction({ to: tx.to, data: tx.data }))
}
await page.addInitScript(arkivPassthrough, ARKIV_RPC)

try {
  await step('load the single-file app and connect the wallet', async () => {
    await page.goto(APP)
    await shot(page, { path: `${SHOTS}-0-landing.png`, fullPage: true })
    await connect(page)
    await shot(page, { path: `${SHOTS}-1-connected.png` })
  })

  await step(`claim ${project}.navik.eth`, async () => {
    await page.getByRole('link', { name: 'New project' }).first().click()
    await page.getByLabel('Project name').fill(project)
    await page.getByText('Available').waitFor()
    await shot(page, { path: `${SHOTS}-1b-claim.png` })
    await page.getByRole('button', { name: `Claim ${project}.navik.eth` }).click()
    await page.getByRole('heading', { name: `${project}.navik.eth` }).waitFor()
    await page.getByText('Owner', { exact: true }).waitFor()
  })

  await step('deploy v1 and promote it', async () => {
    await pickBuild(page, 1)
    await shot(page, { path: `${SHOTS}-1c-deploy.png` })
    await finishDeploy(page, 'Deploy and promote')
    await production(page).filter({ hasText: `1.${project}.navik.eth` }).waitFor()
  })

  await step('deploy v2 without promoting, then promote it', async () => {
    await pickBuild(page, 2)
    await finishDeploy(page, 'Deploy')
    await releaseRow(page, 2).waitFor()
    await production(page).filter({ hasText: `1.${project}.navik.eth` }).waitFor()
    await page.getByText(`preview.${project}.navik.eth`).first().waitFor() // preview follows the newest release
    await releaseRow(page, 2).getByRole('button', { name: 'Promote' }).click()
    await production(page).filter({ hasText: `2.${project}.navik.eth` }).waitFor()
  })

  await step('roll back to v1', async () => {
    await releaseRow(page, 1).getByRole('button', { name: 'Roll back' }).click()
    await production(page).filter({ hasText: `1.${project}.navik.eth` }).waitFor()
    await shot(page, { path: `${SHOTS}-2-project.png`, fullPage: true })
  })

  await step('addresses link to Blockscout; addresses and hashes copy', async () => {
    const owner = page.locator('.page-head a.ext')
    assert.equal(await owner.getAttribute('href'), `https://eth.blockscout.com/address/${ALICE}`)
    assert.equal(await owner.getAttribute('target'), '_blank')
    const meta = releaseRow(page, 1).locator('.muted.small')
    const deployment = (await meta.locator('a.ext').getAttribute('href'))!.split('/').pop()!
    assert.match(deployment, /^0x[0-9a-fA-F]{40}$/)
    await meta.locator('.copy-btn').first().click()
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), deployment)
    const content = page.locator('.prod-info .copy-btn')
    await content.click()
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /^0x[0-9a-f]{64}$/)
    await content.and(page.locator('.copied')).waitFor()
    // identicons are the ENS app's etherloom weave
    assert.match((await page.locator('.page-head img.avatar').getAttribute('src'))!, /^data:image\/svg\+xml/)
  })

  await step('view v2: fetched from Ethereum, hash-checked, rendered sandboxed', async () => {
    await releaseRow(page, 2).getByRole('link', { name: 'View' }).click()
    await page.getByText('Navik release').waitFor()
    await page.getByText('Content hash matches').waitFor()
    await siteFrame(page).getByText('hello from v2').waitFor()
    await shot(page, { path: `${SHOTS}-3-viewer.png`, fullPage: true })
    await page.goBack()
  })

  await step('deploy v3 compressed, view it decompressed', async () => {
    await pickBuild(page, 3, () => modal(page).getByLabel(/Compress \(gzip\)/).check())
    await modal(page).getByText('compressed from').waitFor()
    await finishDeploy(page, 'Deploy')
    await releaseRow(page, 3).waitFor()
    await releaseRow(page, 3).getByRole('link', { name: 'View' }).click()
    await page.getByText('Gzipped').waitFor()
    await siteFrame(page).getByText('hello from v3').waitFor()
    await page.goBack()
  })

  await step('grant a deploy key, then revoke it', async () => {
    await page.locator('.tabs').getByRole('link', { name: 'Access' }).click()
    await page.getByPlaceholder('0x… key address').fill(CI)
    await page.getByRole('button', { name: 'Grant' }).click()
    const row = page.locator('.key-row', { hasText: CI })
    await row.waitFor()
    await row.getByRole('button', { name: 'Revoke deploy' }).click()
    await page.getByText('No keys granted.').waitFor()
    await page.locator('.tabs').getByRole('link', { name: 'Releases' }).click()
  })

  await step('people show as their primary ENS name: a key, and the publisher of a release', async () => {
    await page.locator('.tabs').getByRole('link', { name: 'Access' }).click()
    await page.getByPlaceholder('0x… key address').fill(VITALIK)
    await page.getByRole('button', { name: 'Grant' }).click()
    await page.locator('.key-row', { hasText: 'vitalik.eth' }).waitFor()
    // vitalik.eth publishes release 4 with the key (outside the app, as CI would)
    const { factory } = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../contracts/deployments/31337.json'), 'utf8'))
    const data = encodeFunctionData({
      abi: parseAbi(['function publishContent(string label, bytes[] chunks)']),
      args: [project, [`0x${site(4).toString('hex')}`]],
    })
    await sendAs(VITALIK, factory, data, 'publishing as vitalik.eth')
    await page.goto(`${APP}#/open/4.${project}.navik.eth`)
    await siteFrame(page).getByText('hello from v4').waitFor()
    await page.locator('.source .facts').getByText('vitalik.eth').waitFor()
    await shot(page, { path: `${SHOTS}-3b-publisher-name.png`, fullPage: true })
    await page.goto(`${APP}#/p/${project}/access`)
    await page.locator('.key-row', { hasText: 'vitalik.eth' }).getByRole('button', { name: 'Revoke deploy' }).click()
    await page.getByText('No keys granted.').waitFor()
    await page.locator('.tabs').getByRole('link', { name: 'Releases' }).click()
  })

  await step('link a custom domain: it serves production, then unlink it', async () => {
    const domain = `${project}site.eth`
    await registerEth(`${project}site`, ALICE)
    await page.locator('.tabs').getByRole('link', { name: 'Domains' }).click()
    await page.getByText('No domains linked yet.').waitFor()
    await page.getByPlaceholder('alice.eth').fill(domain)
    await page.getByRole('button', { name: 'Check' }).click()
    await page.locator('.domain-check').getByText('Hides its own records and subnames').waitFor()
    await shot(page, { path: `${SHOTS}-2b-domain-check.png`, fullPage: true })
    await page.getByRole('button', { name: `Link ${domain} (3 transactions)` }).click()
    const row = page.locator('.domain-row', { hasText: domain })
    await row.getByText('Linked').waitFor()
    await shot(page, { path: `${SHOTS}-2c-domains.png`, fullPage: true })
    await row.getByRole('link', { name: domain }).click()
    await siteFrame(page).getByText('hello from v1').waitFor()
    await page.goBack()
    await row.getByRole('button', { name: 'Unlink' }).click()
    await page.getByText('No domains linked yet.').waitFor()
    await page.locator('.tabs').getByRole('link', { name: 'Releases' }).click()
  })

  await step('take production offline', async () => {
    await page.getByRole('button', { name: 'Take offline' }).click()
    await page.getByText('Nothing is live').waitFor()
  })

  await step('every read went through the anon-rpc worker; the wallet only signed', async () => {
    const methods: string[] = await page.evaluate(() => (window as unknown as { walletMethods: string[] }).walletMethods)
    assert.ok(methods.includes('eth_sendTransaction'))
    assert.deepEqual([...new Set(methods)].filter((m) => !WALLET_METHODS.has(m)), [])
    await page.locator('button.pill').click()
    const stats = (await page.locator('.stats').innerText()).replace(/\s+/g, ' ').trim()
    assert.match(stats, /^anon-rpc [1-9]\d* direct 0 wallet [1-9]\d*$/, stats)
    await shot(page, { path: `${SHOTS}-4-privacy.png` })
    await page.locator('.drawer').getByRole('button', { name: 'Close' }).click()
  })

  await step('the project is listed for its owner after a reload', async () => {
    await page.goto(`${APP}#/`)
    await page.reload()
    await connect(page)
    const card = page.locator('.project-card', { hasText: project })
    await card.getByText('release', { exact: false }).waitFor()
    await shot(page, { path: `${SHOTS}-5-projects.png` })
  })

  await step('no requests left the page except to the RPC and the pinned worker code', async () => {
    assert.deepEqual(external, [])
  })

  await step('open a site with no wallet, and compare it with a local build', async () => {
    const viewer = await browser.newPage()
    await viewer.addInitScript(arkivPassthrough, ARKIV_RPC)
    await viewer.goto(`${APP}#/open/1.${project}.navik.eth`)
    await siteFrame(viewer).getByText('hello from v1').waitFor()
    // provenance comes from Arkiv; this release has none, and its publisher is named
    await viewer.locator('.source .badge', { hasText: 'no provenance' }).waitFor()
    await shot(viewer, { path: `${SHOTS}-6-viewer-no-wallet.png` })
    await viewer.locator('.compare input[type=file]').setInputFiles({ name: 'index.html', mimeType: 'text/html', buffer: site(1) })
    await viewer.getByText('index.html is byte-identical to the release').waitFor()
    await viewer.locator('.compare input[type=file]').setInputFiles({ name: 'other.html', mimeType: 'text/html', buffer: site(9) })
    await viewer.getByText('other.html differs').waitFor()
    // with no wallet, the result can be shown but not attested
    await viewer.getByText('Connect a wallet to attest').waitFor()
    // an unknown name fails cleanly
    await viewer.getByLabel('Name to open').fill(`9.${project}.navik.eth`)
    await viewer.getByRole('button', { name: 'Open', exact: true }).click()
    await viewer.getByText('has no contentcontract record').waitFor()
    await viewer.close()
  })

  await step('switch reads to Direct: the panel shows them as direct', async () => {
    await page.locator('button.pill').click()
    await page.locator('.drawer').getByLabel('Ethereum reads').selectOption('direct')
    await page.locator('button.pill', { hasText: 'Direct reads' }).waitFor()
    await page.goto(`${APP}#/open/1.${project}.navik.eth`)
    await siteFrame(page).getByText('hello from v1').waitFor()
    await page.locator('.stats div', { hasText: /direct\s*[1-9]/ }).waitFor() // the panel is still open
  })

  if (ARKIV_KEY) {
    await step('attest a reproduction from the viewer, then keep the records alive (signed on Arkiv)', async () => {
      await page.locator('.drawer').getByRole('button', { name: 'Close' }).click()
      const source = page.locator('.source')
      await source.locator('.badge', { hasText: 'no provenance' }).waitFor()
      await page.locator('.compare input[type=file]').setInputFiles({ name: 'index.html', mimeType: 'text/html', buffer: site(1) })
      await source.getByRole('button', { name: 'Attest: I reproduced it' }).click()
      await source.getByText('Attest on Arkiv: done').waitFor({ timeout: 120_000 })
      await source.locator('.badge', { hasText: 'reproduced ×1' }).waitFor({ timeout: 60_000 })
      await source.locator('.attests li', { hasText: 'via navik-dashboard' }).waitFor()
      await source.getByRole('button', { name: /Keep alive/ }).click()
      await source.getByText('Keep alive: done').waitFor({ timeout: 120_000 })
      await shot(page, { path: `${SHOTS}-7-attested.png` })
    })
  }
  console.log(`\nall app e2e checks passed (screenshots: ${SHOTS}-*.png)`)
} catch (err) {
  await shot(page, { path: `${SHOTS}-failure.png`, fullPage: true })
  console.error(`\nfailed; screenshot: ${SHOTS}-failure.png`)
  throw err
} finally {
  await browser.close()
}
