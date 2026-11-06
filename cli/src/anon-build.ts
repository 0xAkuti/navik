import { resolve } from 'node:path'
import { rolldown } from 'rolldown'

/** The script a headless browser runs for anon reads: anon-page.ts and the anon-rpc harness. */
export async function buildAnonPage(): Promise<string> {
  const bundle = await rolldown({ input: resolve(import.meta.dirname, 'anon-page.ts'), platform: 'browser' })
  const { output } = await bundle.generate({ format: 'iife', minify: true })
  await bundle.close()
  return output[0].code
}
