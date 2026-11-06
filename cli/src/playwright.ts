import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Playwright next to the CLI, else the site's own (e.g. when the CLI runs through npx). */
export async function loadPlaywright(flag: string): Promise<typeof import('playwright')> {
  try {
    return await import('playwright')
  } catch {}
  try {
    const path = createRequire(join(process.cwd(), 'package.json')).resolve('playwright')
    const mod = await import(pathToFileURL(path).href)
    // CommonJS: imported by path, its exports may only be on `default`
    return (mod.chromium ? mod : mod.default) as typeof import('playwright')
  } catch {
    throw new Error(`${flag} needs Playwright: \`npm i -D playwright && npx playwright install chromium\``)
  }
}
