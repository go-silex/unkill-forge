import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'
import coverageScope from './config/coverage-scope.json'

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/index.ts',
      miniflare: {
        compatibilityDate: '2026-08-01',
        compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
        d1Databases: ['DB'],
        r2Buckets: ['BLOBS'],
        kvNamespaces: ['OAUTH_KV'],
        bindings: { TEST_MIGRATIONS: await readD1Migrations('./migrations') },
      },
    }),
  ],
  test: {
    coverage: {
      // Workerd does not expose the V8 coverage profiler.
      provider: 'istanbul',
      ...coverageScope,
      reporter: ['text-summary', 'json-summary'],
    },
  },
})
