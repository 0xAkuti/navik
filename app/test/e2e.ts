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
const APP = pathToFileURL(resolve(import.meta.dirname, '../dist/index.html')).href
const SHOTS = process.env.SHOTS ?? '/tmp/navik-app'

const project = `web${Date.now().toString(36)}`
const site = (v: number) => Buffer.from(`<!doctype html><title>${project}</title><h1>hello from v${v}</h1>`)

function injectWallet({ rpc, account }: { rpc: string; account: string }) {
  let id = 0
  const provider = {
    async request({ method, params }: { method: string; params?: unknown[] }) {
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

const production = (page: Page) => page.locator('.card', { hasText: 'Production' }).locator('.live, p.muted')
const releaseRow = (page: Page, v: number) => page.locator('tr', { hasText: `${project}-v${v}.navik.eth` })

const browser = await chromium.launch()
const page = await browser.newPage()
const external: string[] = []
page.on('request', (r) => {
  const url = r.url()
  if (!/^(file:|data:|blob:)/.test(url) && !url.startsWith(RPC)) external.push(url)
})
page.on('pageerror', (e) => console.error('page error:', e.message))
await page.addInitScript(injectWallet, { rpc: RPC, account: ALICE })

try {
  await step('load the single-file app and connect the wallet', async () => {
    await page.goto(APP)
    await page.getByRole('button', { name: 'Connect Navik Test Wallet' }).click()
    await page.getByText('Your projects').waitFor()
    await page.screenshot({ path: `${SHOTS}-1-connected.png` })
  })

  await step(`claim ${project}.navik.eth`, async () => {
    await page.getByPlaceholder('my-site').fill(project)
    await page.getByRole('button', { name: 'Claim' }).click()
    await page.getByRole('heading', { name: `${project}.navik.eth` }).waitFor()
    await page.getByText('owner', { exact: true }).waitFor()
  })

  await step('deploy v1 and promote it', async () => {
    await page.locator('input[type=file]').setInputFiles({ name: 'index.html', mimeType: 'text/html', buffer: site(1) })
    await page.getByText(`${project}-v1.navik.eth`).first().waitFor()
    await page.getByRole('button', { name: 'Deploy and promote' }).click()
    await page.getByText('Promoted to').waitFor()
    await production(page).filter({ hasText: `${project}-v1.navik.eth` }).waitFor()
  })

  await step('deploy v2 without promoting, then promote it', async () => {
    await page.locator('input[type=file]').setInputFiles({ name: 'index.html', mimeType: 'text/html', buffer: site(2) })
    await page.getByRole('button', { name: 'Deploy', exact: true }).click()
    await releaseRow(page, 2).waitFor()
    await production(page).filter({ hasText: `${project}-v1.navik.eth` }).waitFor()
    await releaseRow(page, 2).getByRole('button', { name: 'Promote' }).click()
    await production(page).filter({ hasText: `${project}-v2.navik.eth` }).waitFor()
  })

  await step('roll back to v1', async () => {
    await releaseRow(page, 1).getByRole('button', { name: 'Roll back' }).click()
    await production(page).filter({ hasText: `${project}-v1.navik.eth` }).waitFor()
    await page.screenshot({ path: `${SHOTS}-2-project.png`, fullPage: true })
  })

  await step('view v2: fetched from Ethereum and hash-checked', async () => {
    const [popup] = await Promise.all([
      page.waitForEvent('popup'),
      releaseRow(page, 2).getByRole('button', { name: 'View' }).click(),
    ])
    await popup.getByText('hello from v2').waitFor()
    await popup.close()
  })

  await step('grant a deploy key, then revoke it', async () => {
    await page.getByPlaceholder('0x… key address').fill(CI)
    await page.getByRole('button', { name: 'Grant' }).click()
    const row = page.locator('tr', { hasText: CI })
    await row.waitFor()
    await row.getByRole('button', { name: 'Revoke deploy' }).click()
    await page.getByText('No keys granted.').waitFor()
  })

  await step('take production offline', async () => {
    await page.getByRole('button', { name: 'Take offline' }).click()
    await page.getByText('Nothing is live').waitFor()
  })

  await step('the project is listed for its owner after a reload', async () => {
    await page.goto(`${APP}#/`)
    await page.reload()
    await page.getByRole('button', { name: 'Connect Navik Test Wallet' }).click()
    await page.locator('.sidebar nav a', { hasText: project }).waitFor()
  })

  await step('no requests left the page except to the wallet RPC', async () => {
    assert.deepEqual(external, [])
  })
  console.log(`\nall app e2e checks passed (screenshots: ${SHOTS}-*.png)`)
} catch (err) {
  await page.screenshot({ path: `${SHOTS}-failure.png`, fullPage: true })
  console.error(`\nfailed; screenshot: ${SHOTS}-failure.png`)
  throw err
} finally {
  await browser.close()
}
