// Drives the built single-file app (dist/index.html) in headless Chromium against a local
// mainnet fork with Navik deployed (scripts/dev-fork.sh). A test wallet is injected via
// EIP-6963 and forwards every request to anvil, whose dev accounts are unlocked.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium, type Page } from 'playwright'

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545'
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' // anvil #1
const CI = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' // anvil #2
// APP_FILE: e.g. the copy of the app fetched from Ethereum with `navik open navik.eth`
const APP = pathToFileURL(process.env.APP_FILE ?? resolve(import.meta.dirname, '../dist/index.html')).href
const SHOTS = process.env.SHOTS ?? '/tmp/navik-app'

const project = `web${Date.now().toString(36)}`
const site = (v: number) => Buffer.from(`<!doctype html><title>${project}</title><h1>hello from v${v}</h1>`)

function injectWallet({ rpc, account }: { rpc: string; account: string }) {
  let id = 0
  const seen: string[] = ((window as unknown as { walletMethods: string[] }).walletMethods = [])
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
      seen.push(method)
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account]
      if (method === 'wallet_switchEthereumChain') return null
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

async function step(name: string, fn: () => Promise<void>) {
  process.stdout.write(`• ${name} … `)
  await fn()
  console.log('ok')
}

// the only requests the app may send to the wallet: no reads, so the wallet's RPC learns nothing
const WALLET_METHODS = new Set(['eth_requestAccounts', 'eth_accounts', 'eth_chainId', 'eth_sendTransaction', 'wallet_switchEthereumChain'])
// the passthrough anon-rpc worker's code, keccak-pinned in the app
const WORKER_BUNDLE = 'https://raw.githubusercontent.com/privacy-ethereum/anon-rpc/'
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

const browser = await chromium.launch()
const page = await browser.newPage()
const external: string[] = []
page.on('request', (r) => {
  const url = r.url()
  if (!/^(file:|data:|blob:|about:)/.test(url) && !url.startsWith(RPC) && !url.startsWith(WORKER_BUNDLE)) external.push(url)
})
page.on('pageerror', (e) => console.error('page error:', e.message))
await page.addInitScript(injectWallet, { rpc: RPC, account: ALICE })

try {
  await step('load the single-file app and connect the wallet', async () => {
    await page.goto(APP)
    await page.screenshot({ path: `${SHOTS}-0-landing.png`, fullPage: true })
    await connect(page)
    await page.screenshot({ path: `${SHOTS}-1-connected.png` })
  })

  await step(`claim ${project}.navik.eth`, async () => {
    await page.getByRole('link', { name: 'New project' }).first().click()
    await page.getByLabel('Project name').fill(project)
    await page.getByText('Available').waitFor()
    await page.screenshot({ path: `${SHOTS}-1b-claim.png` })
    await page.getByRole('button', { name: `Claim ${project}.navik.eth` }).click()
    await page.getByRole('heading', { name: `${project}.navik.eth` }).waitFor()
    await page.getByText('Owner', { exact: true }).waitFor()
  })

  await step('deploy v1 and promote it', async () => {
    await pickBuild(page, 1)
    await page.screenshot({ path: `${SHOTS}-1c-deploy.png` })
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
    await page.screenshot({ path: `${SHOTS}-2-project.png`, fullPage: true })
  })

  await step('view v2: fetched from Ethereum, hash-checked, rendered sandboxed', async () => {
    await releaseRow(page, 2).getByRole('link', { name: 'View' }).click()
    await page.getByText('A Navik release').waitFor()
    await page.getByText('Content hash matches the release manifest').waitFor()
    await siteFrame(page).getByText('hello from v2').waitFor()
    await page.screenshot({ path: `${SHOTS}-3-viewer.png`, fullPage: true })
    await page.goBack()
  })

  await step('deploy v3 compressed, view it decompressed', async () => {
    await pickBuild(page, 3, () => modal(page).getByLabel(/Compress \(gzip\)/).check())
    await modal(page).getByText('compressed from').waitFor()
    await finishDeploy(page, 'Deploy')
    await releaseRow(page, 3).waitFor()
    await releaseRow(page, 3).getByRole('link', { name: 'View' }).click()
    await page.getByText('gzip-wrapped: decompressed').waitFor()
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

  await step('take production offline', async () => {
    await page.getByRole('button', { name: 'Take offline' }).click()
    await page.getByText('Nothing is live').waitFor()
  })

  await step('every read went through the anon-rpc worker; the wallet only signed', async () => {
    const methods: string[] = await page.evaluate(() => (window as unknown as { walletMethods: string[] }).walletMethods)
    assert.ok(methods.includes('eth_sendTransaction'))
    assert.deepEqual([...new Set(methods)].filter((m) => !WALLET_METHODS.has(m)), [])
    await page.locator('button.pill').click()
    await page.locator('button.pill', { hasText: /(^|\D)(\d+)\/\2 reads via anon-rpc$/ }).waitFor()
    await page.getByText(/100% of \d+ reads through anon-rpc/).waitFor()
    const summary = await page.locator('.meter p').first().innerText()
    assert.match(summary, /^[1-9]\d* via anon-rpc .* · 0 direct .*Plus [1-9]\d* wallet requests/, summary)
    await page.screenshot({ path: `${SHOTS}-4-privacy.png` })
    await page.locator('.drawer').getByRole('button', { name: 'Close' }).click()
  })

  await step('the project is listed for its owner after a reload', async () => {
    await page.goto(`${APP}#/`)
    await page.reload()
    await connect(page)
    const card = page.locator('.project-card', { hasText: project })
    await card.getByText('release', { exact: false }).waitFor()
    await page.screenshot({ path: `${SHOTS}-5-projects.png` })
  })

  await step('no requests left the page except to the RPC and the pinned worker code', async () => {
    assert.deepEqual(external, [])
  })

  await step('open a site with no wallet, and compare it with a local build', async () => {
    const viewer = await browser.newPage()
    await viewer.goto(`${APP}#/open/1.${project}.navik.eth`)
    await siteFrame(viewer).getByText('hello from v1').waitFor()
    await viewer.screenshot({ path: `${SHOTS}-6-viewer-no-wallet.png` })
    await viewer.locator('.compare input[type=file]').setInputFiles({ name: 'index.html', mimeType: 'text/html', buffer: site(1) })
    await viewer.getByText('index.html is byte-identical to the release').waitFor()
    await viewer.locator('.compare input[type=file]').setInputFiles({ name: 'other.html', mimeType: 'text/html', buffer: site(9) })
    await viewer.getByText('other.html differs').waitFor()
    // an unknown name fails cleanly
    await viewer.getByLabel('Name to open').fill(`9.${project}.navik.eth`)
    await viewer.getByRole('button', { name: 'Open', exact: true }).click()
    await viewer.getByText('has no contentcontract record').waitFor()
    await viewer.close()
  })

  await step('switch reads to Direct: the panel shows them as direct', async () => {
    await page.locator('button.pill').click()
    await page.getByLabel(/^Direct/).check()
    await page.getByRole('button', { name: 'Apply' }).click()
    await page.locator('button.pill', { hasText: 'Direct reads' }).waitFor()
    await page.goto(`${APP}#/open/1.${project}.navik.eth`)
    await siteFrame(page).getByText('hello from v1').waitFor()
    await page.locator('.meter p', { hasText: /· [1-9]\d* direct/ }).waitFor() // the drawer is still open
  })
  console.log(`\nall app e2e checks passed (screenshots: ${SHOTS}-*.png)`)
} catch (err) {
  await page.screenshot({ path: `${SHOTS}-failure.png`, fullPage: true })
  console.error(`\nfailed; screenshot: ${SHOTS}-failure.png`)
  throw err
} finally {
  await browser.close()
}
