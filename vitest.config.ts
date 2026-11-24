import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

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
    {
      name: 'native-istanbul-provider',
      enforce: 'post',
      config(config) {
        // The pool inlines all dependencies for workerd. The provider's host-only
        // module must keep Node's native CJS interop for its Babel imports.
        const deps = config.test?.server?.deps
        if (deps) deps.inline = [/^(?!.*\/@vitest\/coverage-istanbul\/dist\/provider\.js$)/]
      },
    },
  ],
  test: {
    coverage: {
      // Workerd does not expose the V8 coverage profiler.
      provider: 'istanbul',
      include: ['src/**/*.{ts,tsx}', 'brand/**/*.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
})
