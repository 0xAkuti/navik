import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  // an onchain site is one document, so lazily imported modules (viem's CCIP-Read, for one) are
  // bundled into the main script instead of loaded by URL
  build: { rolldownOptions: { output: { codeSplitting: false } }, chunkSizeWarningLimit: 1500 },
})
